const Attendance = require('../models/Attendance');
const AttendanceSession = require('../models/AttendanceSession');
const Student = require('../models/Student');
const xlsx = require('xlsx');

// Helper to get local date string YYYY-MM-DD
const getLocalDateString = (dateInput = new Date()) => {
  return new Date(dateInput).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
};

// @desc    Mark attendance manually
// @route   POST /api/attendance/manual
// @access  Private (Admin & Faculty)
exports.markAttendance = async (req, res) => {
  try {
    const { studentId, date, status } = req.body;

    if (!studentId || !date || !status) {
      return res.status(400).json({
        success: false,
        message: 'Please provide studentId, date and status'
      });
    }

    const student = await Student.findById(studentId);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }

    let attendance = await Attendance.findOne({
      student: studentId,
      date
    });

    if (attendance) {
      attendance.status = status;
      attendance.markedBy = req.user._id;
      await attendance.save();
    } else {
      attendance = await Attendance.create({
        student: studentId,
        date,
        status,
        markedBy: req.user._id
      });
    }

    res.status(200).json({
      success: true,
      message: `Attendance marked as ${status} successfully`,
      data: attendance
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Temporal session tracker to require 3 consecutive frames
const temporalTracker = {};

// Recognition Accuracy Configuration
const FACE_MATCH_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD) || 0.42; // Calibrated for OpenCV SFace 1-to-N identification (separation >= 0.46)
const MIN_RECOGNITION_MARGIN = 0.05; // Strict margin prevents picking wrong name when two candidates are close
const MIN_FACE_WIDTH = 50; // Filter small/noisy background faces
const MIN_FACE_HEIGHT = 50;
const CONSECUTIVE_MATCHES_REQUIRED = 2; // Require 2 consecutive matching frames for stable confirmation
const liveTemporalTracker = {}; // Keyed by session_studentId for real-time validation

// P1: In-Memory Student Cache to prevent MongoDB bottleneck
let studentEmbeddingsCache = null;
let studentEmbeddingsCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Outlier pruner: removes noisy embeddings captured during bad lighting/movement during registration
const filterStudentEmbeddings = (embeddings) => {
  if (!embeddings || embeddings.length <= 2) return embeddings || [];
  const centroid = new Array(128).fill(0);
  for (const emb of embeddings) {
    for (let k = 0; k < 128; k++) centroid[k] += emb[k];
  }
  for (let k = 0; k < 128; k++) centroid[k] /= embeddings.length;

  const valid = embeddings.filter(emb => cosineDistance(emb, centroid) < 0.40);
  return valid.length >= 3 ? valid : embeddings;
};

// Robust multi-vector matching: uses average of top-2 closest reference embeddings to avoid single-embedding false matches
const getStudentMatchDistance = (faceEmbedding, studentEmbeddings) => {
  if (!studentEmbeddings || studentEmbeddings.length === 0) return 1.0;
  const dists = [];
  for (const ref of studentEmbeddings) {
    dists.push(cosineDistance(faceEmbedding, ref));
  }
  dists.sort((a, b) => a - b);
  return dists.length >= 2 ? (dists[0] + dists[1]) / 2.0 : dists[0];
};

// Helper to load or refresh student embeddings cache with outlier filtering
const getCachedStudents = async () => {
  if (!studentEmbeddingsCache || (Date.now() - studentEmbeddingsCacheTime) > CACHE_TTL_MS) {
    console.log('[CACHE MISS] Fetching student embeddings from MongoDB and filtering outliers...');
    const rawStudents = await Student.find(
      {
        embeddings: {
          $exists: true,
          $not: { $size: 0 }
        }
      },
      {
        _id: 1,
        name: 1,
        rollNumber: 1,
        branch: 1,
        section: 1,
        embeddings: 1
      }
    ).lean();

    studentEmbeddingsCache = rawStudents.map((s) => ({
      ...s,
      embeddings: filterStudentEmbeddings(s.embeddings)
    }));
    studentEmbeddingsCacheTime = Date.now();
  }
  return studentEmbeddingsCache;
};

// Optional helper to forcefully invalidate cache from other routes
exports.invalidateStudentCache = () => {
  studentEmbeddingsCache = null;
  studentEmbeddingsCacheTime = 0;
};

// @desc    Mark attendance via Face Recognition
// @route   POST /api/attendance/mark-face
// @access  Private (Admin & Faculty)
exports.markAttendanceByFace = async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a camera frame image'
      });
    }

    const { postToAi } = require('../utils/aiClient');
    let result;

    try {
      result = await postToAi('/api/recognize', { image }, 1);

      if (!result || !result.success) {
        return res.status(500).json({
          success: false,
          message: result?.message || 'Face recognition service error'
        });
      }

      if (!result.faces || result.faces.length === 0) {
        return res.status(200).json({
          success: true,
          faces: [],
          message: result.message || 'No face detected in webcam feed.'
        });
      }      const todayStr = getLocalDateString();
      const processedFaces = [];
      const students = await getCachedStudents();

      for (let i = 0; i < result.faces.length; i++) {
        const face = result.faces[i];

        if (face.bbox && (face.bbox[2] < MIN_FACE_WIDTH || face.bbox[3] < MIN_FACE_HEIGHT)) {
          processedFaces.push({ ...face, matched: false, status: 'unknown' });
          continue;
        }

        if (!face.embedding || face.embedding.length !== 128) {
          processedFaces.push({ ...face, matched: false, status: 'unknown' });
          continue;
        }

        let candidateMatch = null;
        let candidateBestDistance = 1.0;
        let candidateSecondBestDistance = 1.0;

        for (const student of students) {
          if (!student.embeddings || student.embeddings.length === 0) continue;
          const dist = getStudentMatchDistance(face.embedding, student.embeddings);
          if (dist < candidateBestDistance) {
            candidateSecondBestDistance = candidateBestDistance;
            candidateBestDistance = dist;
            candidateMatch = student;
          } else if (dist < candidateSecondBestDistance) {
            candidateSecondBestDistance = dist;
          }
        }

        const margin = candidateSecondBestDistance - candidateBestDistance;
        if (!candidateMatch || candidateBestDistance > FACE_MATCH_THRESHOLD || margin < MIN_RECOGNITION_MARGIN) {
          processedFaces.push({
            ...face,
            matched: false,
            status: 'unknown'
          });
          continue;
        }

        const student = candidateMatch;
        const existingRecord = await Attendance.findOne({
          student: student._id,
          date: todayStr
        });

        let alreadyMarked = false;
        if (existingRecord && existingRecord.status === 'Present') {
          alreadyMarked = true;
          processedFaces.push({
            ...face,
            matched: true,
            status: 'recognized',
            alreadyMarked: true,
            student: {
              id: student._id,
              name: student.name,
              rollNumber: student.rollNumber,
              branch: student.branch,
              section: student.section
            }
          });
          continue;
        }

        if (existingRecord) {
          existingRecord.status = 'Present';
          existingRecord.markedBy = req.user ? req.user._id : undefined;
          existingRecord.timestamp = new Date();
          await existingRecord.save();
        } else {
          await Attendance.create({
            student: student._id,
            date: todayStr,
            status: 'Present',
            markedBy: req.user ? req.user._id : undefined
          });
        }

        processedFaces.push({
          ...face,
          matched: true,
          status: 'recognized',
          alreadyMarked: false,
          student: {
            id: student._id,
            name: student.name,
            rollNumber: student.rollNumber,
            branch: student.branch,
            section: student.section
          }
        });
      }

      return res.status(200).json({
        success: true,
        faces: processedFaces,
        message: `Processed ${processedFaces.length} faces`
      });
    } catch (aiError) {
      console.error(
        'AI Service Connection Error:',
        aiError.message
      );

      return res.status(502).json({
        success: false,
        message:
          aiError.message ||
          'Could not connect to the AI Face Service. Please check if the Python AI service is running.'
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Helper for Cosine Distance
const cosineDistance = (v1, v2) => {
  let dotProduct = 0.0;
  let norm1 = 0.0;
  let norm2 = 0.0;

  for (let i = 0; i < v1.length; i++) {
    dotProduct += v1[i] * v2[i];
    norm1 += v1[i] * v1[i];
    norm2 += v2[i] * v2[i];
  }

  if (norm1 === 0 || norm2 === 0) {
    return 1.0;
  }

  return (
    1.0 -
    dotProduct /
      (Math.sqrt(norm1) * Math.sqrt(norm2))
  );
};

// @desc    Mark attendance via Face Recognition
// @route   POST /api/attendance/recognize
// @access  Private (Admin & Faculty)
exports.recognizeFace = async (req, res) => {
  try {
    const { image, sessionId } = req.body;

    if (!image || !sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an image and sessionId'
      });
    }

    const session = await AttendanceSession.findById(sessionId);

    if (!session || session.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Invalid or inactive session'
      });
    }

    console.log('[ATTENDANCE SCAN]');

    const { postToAi } = require('../utils/aiClient');

    let result;

    try {
      result = await postToAi(
        '/api/recognize',
        { image },
        1
      );
    } catch (aiError) {
      console.error(
        'AI Service Connection Error:',
        aiError.message
      );

      return res.status(502).json({
        success: false,
        message:
          aiError.message ||
          'Could not connect to the AI Face Service.'
      });
    }

    if (
      !result ||
      !result.success ||
      !result.faces ||
      result.faces.length === 0
    ) {
      return res.status(200).json({
        faceDetected: false,
        matched: false,
        message: 'No face detected'
      });
    }

    console.log('[FACE DETECTED]');

    const face = result.faces[0]; // REMOVED: Loop over all faces instead

    // Phase 1: Load from Node.js memory cache instead of MongoDB (with outlier filtering)
    const students = await getCachedStudents();

    const recognizedCandidates = [];
    const currentFrameMatches = new Set();
    const sessionPrefix = session._id.toString() + '_';
    const now = Date.now();

    console.log(`[FACE SCAN] Found ${result.faces.length} faces in frame.`);

    for (let i = 0; i < result.faces.length; i++) {
        const currentFace = result.faces[i];
        
        // 1. Size Validation (bbox = [x, y, w, h])
        if (currentFace.bbox && (currentFace.bbox[2] < MIN_FACE_WIDTH || currentFace.bbox[3] < MIN_FACE_HEIGHT)) {
            console.log(`[FACE REJECTED] Face #${i} too small: ${currentFace.bbox[2]}x${currentFace.bbox[3]}`);
            continue;
        }
        
        if (!currentFace.embedding || currentFace.embedding.length !== 128) {
            console.log(`[FACE REJECTED] Face #${i} has invalid embedding`);
            continue;
        }
        
        // 2. Candidate Comparison
        let candidateMatch = null;
        let candidateBestDistance = 1.0;
        let candidateSecondBestDistance = 1.0;
        let closestObserved = 1.0;

        for (const student of students) {
            if (!student.embeddings || student.embeddings.length === 0) continue;
            
            const studentDist = getStudentMatchDistance(currentFace.embedding, student.embeddings);
            
            if (studentDist < closestObserved) closestObserved = studentDist;

            if (studentDist < candidateBestDistance) {
                candidateSecondBestDistance = candidateBestDistance;
                candidateBestDistance = studentDist;
                candidateMatch = student;
            } else if (studentDist < candidateSecondBestDistance) {
                candidateSecondBestDistance = studentDist;
            }
        }
        
        // 3. Threshold Check & Ambiguity Check
        if (candidateMatch && candidateBestDistance <= FACE_MATCH_THRESHOLD) {
            const margin = candidateSecondBestDistance - candidateBestDistance;
            if (margin >= MIN_RECOGNITION_MARGIN) {
                 recognizedCandidates.push({ student: candidateMatch, distance: candidateBestDistance, margin });
                 currentFrameMatches.add(candidateMatch._id.toString());
                 console.log(`[FACE MATCHED] Face #${i} -> ${candidateMatch.name} (Dist: ${candidateBestDistance.toFixed(3)}, Margin: ${margin.toFixed(3)})`);
            } else {
                 console.log(`[FACE REJECTED] Ambiguous match for Face #${i} (${candidateMatch.name}). Margin: ${margin.toFixed(3)} < ${MIN_RECOGNITION_MARGIN}`);
            }
        } else {
             const bestName = candidateMatch ? candidateMatch.name : 'Unknown';
             console.log(`[FACE REJECTED] Face #${i} closest to ${bestName} (Dist: ${candidateBestDistance.toFixed(3)} > ${FACE_MATCH_THRESHOLD})`);
        }
    }
    
    // 4. Temporal Tracking to prevent cross-user contamination and single-frame false positives
    for (const key of Object.keys(liveTemporalTracker)) {
       if (key.startsWith(sessionPrefix)) {
           const studentIdStr = key.replace(sessionPrefix, '');
           if (!currentFrameMatches.has(studentIdStr)) {
               delete liveTemporalTracker[key]; // Reset if they disappeared in this frame
           }
       }
    }
    
    let finalConfirmedCandidate = null;
    
    for (const candidate of recognizedCandidates) {
        const key = sessionPrefix + candidate.student._id.toString();
        if (!liveTemporalTracker[key]) {
            liveTemporalTracker[key] = { count: 1, lastSeen: now };
        } else {
            liveTemporalTracker[key].count += 1;
            liveTemporalTracker[key].lastSeen = now;
        }
        
        console.log(`[TEMPORAL] ${candidate.student.name}: ${liveTemporalTracker[key].count}/${CONSECUTIVE_MATCHES_REQUIRED} consecutive frames`);
        
        if (liveTemporalTracker[key].count >= CONSECUTIVE_MATCHES_REQUIRED) {
            if (!finalConfirmedCandidate || candidate.distance < finalConfirmedCandidate.distance) {
                finalConfirmedCandidate = candidate;
            }
        }
    }
    
    if (!finalConfirmedCandidate) {
      return res.status(200).json({
        faceDetected: true,
        matched: false,
        message: recognizedCandidates.length > 0 
            ? 'Validating match (need more frames)' 
            : 'No confident match found'
      });
    }

    const bestMatch = finalConfirmedCandidate.student;
    const bestDistance = finalConfirmedCandidate.distance;
    
    console.log(`[STUDENT CONFIRMED] ${bestMatch.name} with distance ${bestDistance.toFixed(3)}`);

    const todayStr = getLocalDateString();

    const existingRecord = await Attendance.findOne({
      student: bestMatch._id,
      session: session._id
    });

    let confidence = 0;
    if (bestDistance <= FACE_MATCH_THRESHOLD) {
      const rawScore = Math.max(0, 1 - bestDistance / FACE_MATCH_THRESHOLD);
      confidence = 0.75 + (rawScore * 0.25);
    }

    let student = bestMatch._id;

    // Phase 2/5: ActivityState Check with Configurable Cooldown
    const ActivityState = require('../models/ActivityState');
    let state = await ActivityState.findOne({ student, session: session._id });
    
    if (!state) {
      return res.status(200).json({
        faceDetected: true,
        success: true,
        matched: true,
        name: bestMatch.name,
        rollNumber: bestMatch.rollNumber,
        studentId: student,
        confidence: Number(confidence.toFixed(4)),
        action: 'LOGIN_AVAILABLE',
        message: 'Ready for login'
      });
    }

    if (state.currentState === 'IN') {
      return res.status(200).json({
        faceDetected: true,
        success: true,
        matched: true,
        name: bestMatch.name,
        rollNumber: bestMatch.rollNumber,
        studentId: student,
        confidence: Number(confidence.toFixed(4)),
        action: 'LOGOUT_AVAILABLE',
        message: 'Ready for logout'
      });
    } else {
      return res.status(200).json({
        faceDetected: true,
        success: true,
        matched: true,
        name: bestMatch.name,
        rollNumber: bestMatch.rollNumber,
        studentId: student,
        confidence: Number(confidence.toFixed(4)),
        action: 'LOGIN_AVAILABLE',
        message: 'Ready for login'
      });
    }
  } catch (error) {
    console.error(
      '[RECOGNIZE FACE ERROR]',
      error
    );

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get attendance logs
// @route   GET /api/attendance/logs
// @access  Private (Admin & Faculty)
exports.getAttendanceLogs = async (req, res) => {
  try {
    const {
      date,
      rollNumber,
      branch,
      section,
      startDate,
      endDate
    } = req.query;

    let studentQuery = {};

    if (rollNumber) {
      studentQuery.rollNumber =
        rollNumber.toUpperCase();
    }

    if (branch) {
      studentQuery.branch = branch;
    }

    if (section) {
      studentQuery.section =
        section.toUpperCase();
    }

    let studentIds = [];

    if (Object.keys(studentQuery).length > 0) {
      const students = await Student.find(
        studentQuery
      ).select('_id');

      studentIds = students.map(
        (s) => s._id
      );

      if (studentIds.length === 0) {
        return res.status(200).json({
          success: true,
          count: 0,
          data: []
        });
      }
    }

    let attendanceQuery = {};

    if (studentIds.length > 0) {
      attendanceQuery.student = {
        $in: studentIds
      };
    }

    if (date) {
      attendanceQuery.date = date;
    } else if (startDate && endDate) {
      attendanceQuery.date = {
        $gte: startDate,
        $lte: endDate
      };
    }

    // Filter to only include successfully marked present students
    attendanceQuery.status = 'Present';

    const logs = await Attendance.find(
      attendanceQuery
    )
      .populate(
        'student',
        'name rollNumber branch section email'
      )
      .populate(
        'markedBy',
        'name email role'
      )
      .sort({ timestamp: -1 });

    res.status(200).json({
      success: true,
      count: logs.length,
      data: logs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get dashboard statistics
// @route   GET /api/attendance/dashboard
// @access  Private
exports.getDashboardStats = async (req, res) => {
  try {
    const todayStr = getLocalDateString();

    const totalStudents =
      await Student.countDocuments({});

    const presentTodayIds =
      await Attendance.distinct('student', {
        date: todayStr,
        status: 'Present'
      });
    const presentToday = presentTodayIds.length;

    const absentToday = Math.max(
      0,
      totalStudents - presentToday
    );

    const attendancePercentage =
      totalStudents > 0
        ? Math.round(
            (presentToday / totalStudents) *
              100
          )
        : 0;

    const recentLogs = await Attendance.find({
      date: todayStr
    })
      .populate(
        'student',
        'name rollNumber branch section'
      )
      .sort({ timestamp: -1 })
      .limit(5);

    const trends = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();

      d.setDate(d.getDate() - i);

      const dateStr =
        getLocalDateString(d);

      const presentCountIds =
        await Attendance.distinct('student', {
          date: dateStr,
          status: 'Present'
        });
      const presentCount = presentCountIds.length;

      const dayLabel =
        d.toLocaleDateString(
          'en-US',
          {
            weekday: 'short'
          }
        );

      trends.push({
        date: dateStr,
        label: dayLabel,
        present: presentCount,
        absent: Math.max(
          0,
          totalStudents - presentCount
        ),
        rate:
          totalStudents > 0
            ? Math.round(
                (presentCount /
                  totalStudents) *
                  100
              )
            : 0
      });
    }

    res.status(200).json({
      success: true,
      data: {
        stats: {
          totalStudents,
          presentToday,
          absentToday,
          attendancePercentage
        },
        recentLogs,
        trends
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ==========================================
// SESSION MANAGEMENT CONTROLLERS
// ==========================================

// @desc    Start a new attendance session
// @route   POST /api/attendance/session/start
// @access  Private
exports.startSession = async (req, res) => {
  try {
    const { sessionName } = req.body;

    if (!sessionName || !sessionName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Session name is required'
      });
    }

    const todayStr = getLocalDateString();
    
    // Generate a secure unique sessionId to eliminate E11000 race conditions
    const crypto = require('crypto');
    const randomHex = crypto.randomBytes(2).toString('hex').toUpperCase();
    const timestamp = Date.now().toString().slice(-6); // last 6 digits of timestamp
    const sessionId = `SESSION_${todayStr.replace(/-/g, '')}_${timestamp}_${randomHex}`;

    // Finalize any previous active sessions to ensure only ONE session is active
    const previousActive = await AttendanceSession.find({ status: 'active' });
    if (previousActive.length > 0) {
      const prevIds = previousActive.map(p => p._id);
      await AttendanceSession.updateMany(
        { _id: { $in: prevIds } },
        { $set: { status: 'completed', endTime: new Date() } }
      );
      const Attendance = require('../models/Attendance');
      await Attendance.updateMany(
        { session: { $in: prevIds }, cycleStatus: 'OPEN' },
        { $set: { cycleStatus: 'COMPLETED', logoutTime: new Date() } }
      );
    }

    const newSession = await AttendanceSession.create({
      sessionId,
      sessionName: sessionName.trim(),
      date: todayStr,
      status: 'active',
      markedBy: req.user._id
    });

    console.log(`[SESSION STARTED] ${sessionId} - ${sessionName.trim()}`);

    res.status(201).json({
      success: true,
      data: newSession
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get current active session and attendee list
// @route   GET /api/attendance/session/active
// @access  Private
exports.getActiveSession = async (req, res) => {
  try {
    const AttendanceSession = require('../models/AttendanceSession');
    const ActivityState = require('../models/ActivityState');
    const Attendance = require('../models/Attendance');

    // Automatically complete any stale active sessions older than 12 hours
    const staleCutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
    await AttendanceSession.updateMany(
      { status: 'active', createdAt: { $lt: staleCutoff } },
      { $set: { status: 'completed', endTime: new Date() } }
    );

    const activeSession = await AttendanceSession.findOne({ status: 'active' }).sort({ createdAt: -1 });

    if (!activeSession) {
      return res.status(200).json({
        success: true,
        data: null,
        attendees: []
      });
    }

    // Fetch existing attendees for this session
    const states = await ActivityState.find({ session: activeSession._id })
      .populate('student', 'name rollNumber branch section')
      .sort({ updatedAt: -1 });
      
    const cycles = await Attendance.find({ session: activeSession._id })
      .populate('student', 'name rollNumber branch section')
      .sort({ loginTime: -1 });

    const attendeesMap = {};
    states.forEach(st => {
      if (!st.student) return;
      const sId = st.student._id.toString();
      attendeesMap[sId] = {
        id: sId,
        name: st.student.name,
        rollNumber: st.student.rollNumber || sId,
        type: st.currentState === 'IN' ? 'LOGIN' : 'LOGOUT',
        time: st.lastLoginTime ? new Date(st.lastLoginTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
      };
    });

    cycles.forEach(cy => {
      if (!cy.student) return;
      const sId = cy.student._id.toString();
      if (!attendeesMap[sId]) {
        attendeesMap[sId] = {
          id: sId,
          name: cy.student.name,
          rollNumber: cy.student.rollNumber || sId,
          type: cy.cycleStatus === 'OPEN' ? 'LOGIN' : 'LOGOUT',
          time: cy.loginTime ? new Date(cy.loginTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
        };
      }
    });

    const attendees = Object.values(attendeesMap);

    return res.status(200).json({
      success: true,
      data: activeSession,
      attendees
    });
  } catch (error) {
    console.error('getActiveSession error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Stop active session and generate Absents
// @route   POST /api/attendance/session/stop
// @access  Private
exports.stopSession = async (req, res) => {
  try {
    const { sessionId } = req.body;

    const session =
      await AttendanceSession.findById(
        sessionId
      );

    if (
      !session ||
      session.status !== 'active'
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Invalid or already completed session'
      });
    }

    session.status = 'completed';
    session.endTime = new Date();

    await session.save();

    // Close any open attendance cycles
    const openCycles = await Attendance.find({ session: session._id, cycleStatus: 'OPEN' });
    const ActivityState = require('../models/ActivityState');
    
    for (const cycle of openCycles) {
      cycle.cycleStatus = 'COMPLETED';
      cycle.logoutTime = session.endTime;
      
      const durationMs = cycle.logoutTime.getTime() - new Date(cycle.loginTime).getTime();
      cycle.durationMinutes = Math.max(0, Math.round(durationMs / 60000));
      await cycle.save();

      // Update ActivityState
      const state = await ActivityState.findOne({ student: cycle.student, session: session._id });
      if (state) {
         state.currentState = 'OUT';
         state.totalDurationMinutes = (state.totalDurationMinutes || 0) + cycle.durationMinutes;
         await state.save();
      }
    }

    const presentRecords =
      await Attendance.find({
        session: session._id,
        status: 'Present'
      }).select('student');

    const presentStudentIds =
      presentRecords.map((r) =>
        r.student.toString()
      );

    const missingStudents =
      await Student.find({
        _id: {
          $nin: presentStudentIds
        }
      });

    const absentDocs =
      missingStudents.map((student) => ({
        student: student._id,
        session: session._id,
        date: session.date,
        status: 'Absent',
        detectedTime: '-',
        markedBy: req.user._id
      }));

    if (absentDocs.length > 0) {
      await Attendance.insertMany(
        absentDocs
      );
    }

    console.log(
      `[SESSION STOPPED] Total Present: ${presentStudentIds.length}, Total Absent: ${absentDocs.length}`
    );

    res.status(200).json({
      success: true,
      sessionId: session.sessionId,
      presentCount: presentStudentIds.length,
      absentCount: absentDocs.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get session report
// @route   GET /api/attendance/session/:id/report
// @access  Private
exports.getSessionReport = async (
  req,
  res
) => {
  try {
    const session =
      await AttendanceSession.findById(
        req.params.id
      );

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    const records =
      await Attendance.find({
        session: session._id,
        status: 'Present'
      })
        .populate(
          'student',
          'name rollNumber branch section'
        )
        .sort({
          status: -1,
          detectedTime: 1
        });

    res.status(200).json({
      success: true,
      session,
      records
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Generate Excel for a session
// @route   GET /api/attendance/session/:id/excel
// @access  Private
exports.downloadSessionExcel =
  async (req, res) => {
    try {
      const session =
        await AttendanceSession.findById(
          req.params.id
        );

      if (!session) {
        return res.status(404).json({
          success: false,
          message: 'Session not found'
        });
      }

      const records =
        await Attendance.find({
          session: session._id,
          status: 'Present'
        })
          .populate(
            'student',
            'name rollNumber branch year category'
          )
          .sort({
            status: -1,
            detectedTime: 1
          });

      const ExcelJS =
        require('exceljs');

      const workbook =
        new ExcelJS.Workbook();

      const worksheet =
        workbook.addWorksheet(
          'Attendance Report'
        );

      worksheet.columns = [
        {
          header: 'Roll No',
          key: 'rollNo',
          width: 18
        },
        {
          header: 'Student Name',
          key: 'studentName',
          width: 25
        },
        {
          header: 'Branch',
          key: 'branch',
          width: 15
        },
        {
          header: 'Year',
          key: 'year',
          width: 15
        },
        {
          header: 'Category',
          key: 'category',
          width: 15
        },
        {
          header: 'Status',
          key: 'status',
          width: 15
        },
        {
          header: 'Detection Time',
          key: 'detectedTime',
          width: 18
        },
        {
          header: 'Session ID',
          key: 'sessionId',
          width: 22
        },
        {
          header: 'Screenshot Reference',
          key: 'screenshot',
          width: 25
        }
      ];

      worksheet.getRow(1).font = {
        bold: true
      };

      const fs = require('fs');
      const path = require('path');

      records.forEach((record) => {
        const dataRow =
          worksheet.addRow({
            sessionId:
              session.sessionId,
            date: session.date,
            rollNo:
              record.student
                ? record.student.rollNumber
                : 'Unknown',
            studentName:
              record.student
                ? record.student.name
                : 'Unknown',
            branch:
              record.student
                ? record.student.branch || 'N/A'
                : 'Unknown',
            year:
              record.student
                ? record.student.year || 'N/A'
                : 'Unknown',
            category:
              record.student
                ? record.student.category || 'N/A'
                : 'Unknown',
            status: record.status,
            detectedTime:
              record.status ===
              'Present'
                ? record.detectedTime
                : '-',
            screenshot:
              record.screenshotUrl ||
              'N/A'
          });

        dataRow.height = 20;

        if (record.screenshotUrl) {
          try {
            const filename =
              record.screenshotUrl
                .split('/')
                .pop();

            const imagePath =
              path.join(
                __dirname,
                '../../public/screenshots',
                filename
              );

            if (
              fs.existsSync(imagePath)
            ) {
              const imageId =
                workbook.addImage({
                  filename:
                    imagePath,
                  extension: 'jpeg'
                });

              worksheet.addImage(
                imageId,
                {
                  tl: {
                    col: 8,
                    row:
                      dataRow.number -
                      1
                  },
                  ext: {
                    width: 40,
                    height: 40
                  }
                }
              );

              dataRow.height = 45;
              dataRow.getCell(9).value =
                '';
            }
          } catch (err) {
            console.error(
              'Failed to embed screenshot:',
              err
            );
          }
        }
      });

      const buffer =
        await workbook.xlsx.writeBuffer();

      console.log(
        '[EXCEL GENERATED]'
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename=${session.sessionId}_Report.xlsx`
      );

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      res.send(buffer);
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  };

// @desc    Download session Excel report
// @route   GET /api/attendance/session/:id/excel
// @access  Private
exports.downloadSessionExcel = async (req, res) => {
  try {
    const AttendanceSession = require('../models/AttendanceSession');
    const session = await AttendanceSession.findById(req.params.id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const ActivityState = require('../models/ActivityState');
    const Attendance = require('../models/Attendance');
    const Student = require('../models/Student');
    
    const allStudents = await Student.find({}).select('name rollNumber branch year category');
    const states = await ActivityState.find({ session: session._id });
    const cycles = await Attendance.find({ session: session._id }).sort({ loginTime: 1 });

    const studentCycles = {};
    cycles.forEach(c => {
      const sId = c.student.toString();
      if (!studentCycles[sId]) studentCycles[sId] = [];
      studentCycles[sId].push(c);
    });

    const studentStates = {};
    states.forEach(s => {
       studentStates[s.student.toString()] = s.totalDurationMinutes || 0;
    });

    let maxIntervals = 1; // Minimum 1 for header consistency
    const reportData = allStudents.map(student => {
      const studentId = student._id.toString();
      // Filter out the 'Absent' placeholder docs generated by stopSession so we don't count them as cycles
      const stCycles = (studentCycles[studentId] || []).filter(c => c.status !== 'Absent');
      const isAbsent = stCycles.length === 0;
      
      let loginCount = 0;
      let logoutCount = 0;

      stCycles.forEach(c => {
        loginCount++;
        if (c.cycleStatus === 'COMPLETED') {
          logoutCount++;
        }
      });

      if (stCycles.length > maxIntervals) maxIntervals = stCycles.length;

      return {
        student: student,
        status: isAbsent ? 'Absent' : 'Present',
        totalLogins: loginCount,
        totalLogouts: logoutCount,
        totalDuration: Math.round(studentStates[studentId] || 0),
        cycles: stCycles
      };
    }).filter(data => data.status === 'Present');

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance Report');

    const columns = [
      { header: 'Roll No', key: 'rollNo', width: 18 },
      { header: 'Student Name', key: 'studentName', width: 25 },
      { header: 'Branch', key: 'branch', width: 15 },
      { header: 'Year', key: 'year', width: 15 },
      { header: 'Category', key: 'category', width: 15 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Session ID', key: 'sessionId', width: 25 },
      { header: 'Session Name', key: 'sessionName', width: 25 },
      { header: 'Total Logins', key: 'totalLogins', width: 15 },
      { header: 'Total Logouts', key: 'totalLogouts', width: 15 },
      { header: 'Total Duration (Mins)', key: 'totalDuration', width: 22 }
    ];

    for (let i = 1; i <= maxIntervals; i++) {
      columns.push({ header: 'Login ' + i, key: 'login_' + i, width: 20 });
      columns.push({ header: 'Logout ' + i, key: 'logout_' + i, width: 20 });
    }

    worksheet.columns = columns;
    worksheet.getRow(1).font = { bold: true };

    const isActive = session.status === 'active';

    reportData.forEach(row => {
      const rowData = {
        rollNo: row.student.rollNumber,
        studentName: row.student.name,
        branch: row.student.branch,
        year: row.student.year,
        category: row.student.category,
        status: row.status,
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        totalLogins: row.totalLogins,
        totalLogouts: row.totalLogouts,
        totalDuration: row.totalDuration
      };

      if (row.status === 'Absent') {
         rowData['login_1'] = 'Not Yet';
         rowData['logout_1'] = 'Not Yet';
      } else {
        row.cycles.forEach((c, idx) => {
          const i = idx + 1;
          rowData['login_' + i] = c.loginTime ? new Date(c.loginTime).toLocaleTimeString() : '';
          
          let logoutStr = '';
          if (c.cycleStatus === 'COMPLETED') {
            if (session.endTime && c.logoutTime && new Date(c.logoutTime).getTime() === new Date(session.endTime).getTime()) {
              logoutStr = "Didn't Do Logout";
            } else {
              logoutStr = new Date(c.logoutTime).toLocaleTimeString();
            }
          } else {
            logoutStr = isActive ? 'Not Yet' : "Didn't Do Logout";
          }
          rowData['logout_' + i] = logoutStr;
        });
      }

      worksheet.addRow(rowData);
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=' + session.sessionId + '_Report.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.clearActiveSession = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID required' });
    const session = await require('../models/AttendanceSession').findById(sessionId);
    if (!session || session.status !== 'active') return res.status(400).json({ success: false, message: 'Invalid or completed session cannot be cleared' });
    await require('../models/Attendance').deleteMany({ session: session._id });
    await require('../models/AttendanceSession').findByIdAndDelete(session._id);
    res.status(200).json({ success: true, message: 'Active session data cleared successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.confirmActivity = async (req, res) => {
  try {
    const { studentId, sessionId, action, image } = req.body;
    const AttendanceSession = require('../models/AttendanceSession');
    const session = await AttendanceSession.findById(sessionId);
    if (!session || session.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    const ActivityState = require('../models/ActivityState');
    const ActivityEvent = require('../models/ActivityEvent');
    const Attendance = require('../models/Attendance');
    const Student = require('../models/Student');
    const fs = require('fs');
    const path = require('path');

    let state = await ActivityState.findOne({ student: studentId, session: sessionId });
    
    // Process image if provided
    let screenshotUrl = null;
    if (image) {
      try {
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        const filename = `${studentId}_${Date.now()}.jpg`;
        const filepath = path.join(__dirname, '../../public/screenshots', filename);
        if (!fs.existsSync(path.dirname(filepath))) {
            fs.mkdirSync(path.dirname(filepath), { recursive: true });
        }
        await fs.promises.writeFile(filepath, base64Data, 'base64');
        screenshotUrl = `/screenshots/${filename}`;
      } catch (err) {
        console.error("Screenshot save failed", err);
      }
    }

    if (action === 'LOGIN') {
      // Check if there is already an open cycle
      const openCycle = await Attendance.findOne({ student: studentId, session: sessionId, cycleStatus: 'OPEN' });
      if (openCycle) {
        return res.status(400).json({ success: false, message: 'Student already has an open cycle in this session' });
      }

      if (!state) {
        state = new ActivityState({ student: studentId, session: sessionId, totalDurationMinutes: 0 });
      }
      
      const loginTime = Date.now();
      state.currentState = 'IN';
      state.lastLoginTime = loginTime;
      await state.save();
      
      // Create new Attendance cycle
      await Attendance.create({
        student: studentId,
        session: sessionId,
        date: new Date(loginTime).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
        loginTime: loginTime,
        loginScreenshot: screenshotUrl,
        cycleStatus: 'OPEN'
      });

      await ActivityEvent.create({ student: studentId, session: sessionId, eventType: 'LOGIN', screenshotUrl });

      const io = req.app.get('io');
      if (io) {
        io.emit('activity_logged', { type: 'LOGIN', studentId, sessionId });
      }
      
      const studentData = await Student.findById(studentId);
      if (io) {
        io.emit('attendance_logged', {
          student: studentData,
          session: sessionId,
          time: new Date().toLocaleTimeString()
        });
      }

      return res.status(200).json({ success: true, message: 'Login confirmed' });
    } else if (action === 'LOGOUT') {
      const openCycle = await Attendance.findOne({ student: studentId, session: sessionId, cycleStatus: 'OPEN' });
      if (!openCycle) {
        return res.status(400).json({ success: false, message: 'No open cycle found to logout from' });
      }

      const logoutTime = Date.now();
      const durationMs = logoutTime - new Date(openCycle.loginTime).getTime();
      const duration = Math.max(0, Math.round(durationMs / 60000));
      
      openCycle.logoutTime = logoutTime;
      openCycle.logoutScreenshot = screenshotUrl;
      openCycle.durationMinutes = duration;
      openCycle.cycleStatus = 'COMPLETED';
      await openCycle.save();

      state.currentState = 'OUT';
      state.totalDurationMinutes = Math.round((state.totalDurationMinutes || 0) + duration);
      state.lastLogoutTime = logoutTime;
      await state.save();
      
      await ActivityEvent.create({ student: studentId, session: sessionId, eventType: 'LOGOUT', screenshotUrl });
      const io = req.app.get('io');
      if (io) {
        io.emit('activity_logged', { type: 'LOGOUT', studentId, sessionId });
      }
      return res.status(200).json({ success: true, message: 'Logout confirmed' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


exports.getAllSessions = async (req, res) => {
  try {
    const AttendanceSession = require('../models/AttendanceSession');
    const sessions = await AttendanceSession.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: sessions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getSessionLiveTracking = async (req, res) => {
  try {
    const Attendance = require('../models/Attendance');
    const ActivityState = require('../models/ActivityState');
    
    const states = await ActivityState.find({ session: req.params.id }).populate('student', 'name rollNumber branch section');
    // Only fetch Present attendance cycles (ignore auto-inserted Absent records)
    const cycles = await Attendance.find({ 
      session: req.params.id,
      status: { $ne: 'Absent' },
      loginTime: { $exists: true, $ne: null }
    }).populate('student', 'name rollNumber branch section').sort({ loginTime: 1 });
    
    const studentCycles = {};
    cycles.forEach(c => {
      if (!c.student || c.status === 'Absent' || !c.loginTime) return;
      const sId = (c.student._id || c.student).toString();
      if (!studentCycles[sId]) studentCycles[sId] = [];
      const cycleObj = c.toObject ? c.toObject() : { ...c };
      if (cycleObj.durationMinutes !== undefined && cycleObj.durationMinutes !== null) {
        cycleObj.durationMinutes = Math.round(cycleObj.durationMinutes);
      }
      studentCycles[sId].push(cycleObj);
    });

    const studentsMap = {};
    states.forEach(state => {
      if (!state.student) return;
      // Only include if student has an actual login event
      if (!state.lastLoginTime && (!studentCycles[state.student._id.toString()] || studentCycles[state.student._id.toString()].length === 0)) {
        return;
      }
      const sId = state.student._id.toString();
      studentsMap[sId] = {
        student: state.student,
        currentState: state.currentState,
        lastLoginTime: state.lastLoginTime,
        lastLogoutTime: state.lastLogoutTime,
        totalDurationMinutes: Math.round(state.totalDurationMinutes || 0),
        cycles: studentCycles[sId] || []
      };
    });

    cycles.forEach(c => {
      if (!c.student || !c.student._id || c.status === 'Absent' || !c.loginTime) return;
      const sId = c.student._id.toString();
      if (!studentsMap[sId]) {
        const latestCycle = studentCycles[sId] ? studentCycles[sId][studentCycles[sId].length - 1] : c;
        studentsMap[sId] = {
          student: c.student,
          currentState: latestCycle && latestCycle.cycleStatus === 'OPEN' ? 'IN' : 'OUT',
          lastLoginTime: latestCycle ? latestCycle.loginTime : null,
          lastLogoutTime: latestCycle ? latestCycle.logoutTime : null,
          totalDurationMinutes: latestCycle ? (latestCycle.durationMinutes || 0) : 0,
          cycles: studentCycles[sId] || [c]
        };
      }
    });

    // Ensure ONLY present students with recorded login activity are returned
    const data = Object.values(studentsMap).filter(item => {
      const hasLogin = !!item.lastLoginTime;
      const hasValidCycles = Array.isArray(item.cycles) && item.cycles.some(c => c.loginTime && c.status !== 'Absent');
      return hasLogin || hasValidCycles;
    });
    data.sort((a, b) => new Date(b.lastLoginTime || 0) - new Date(a.lastLoginTime || 0));

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('getSessionLiveTracking error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

