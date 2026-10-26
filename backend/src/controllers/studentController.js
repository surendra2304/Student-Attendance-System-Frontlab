const Student = require('../models/Student');
const Attendance = require('../models/Attendance');
const { invalidateStudentCache } = require('./attendanceController');

// @desc    Get all students (with optional search/filtering)
// @route   GET /api/students
// @access  Private (Admin & Faculty)
exports.getStudents = async (req, res) => {
  try {
    const { search, branch, section } = req.query;
    let query = {};

    // Search by Name or Roll Number
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { rollNumber: { $regex: search, $options: 'i' } }
      ];
    }

    // Filter by branch
    if (branch) {
      query.branch = branch;
    }

    // Filter by section
    if (section) {
      query.section = section;
    }

    const students = await Student.find(query).sort({ rollNumber: 1 });

    res.status(200).json({
      success: true,
      count: students.length,
      data: students
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single student
// @route   GET /api/students/:id
// @access  Private
exports.getStudentById = async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    res.status(200).json({ success: true, data: student });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create new student
// @route   POST /api/students
// @access  Private (Admin only)
exports.createStudent = async (req, res) => {
  try {
    const { name, rollNumber, branch, section, email, year, category } = req.body;

    // Validate inputs
    if (!name || !rollNumber || !branch || !section || !email || !year || !category) {
      return res.status(400).json({ success: false, message: 'Please provide all details' });
    }

    // Validate year enum
    const validYears = ['First Year', 'Second Year', 'Third Year', 'Fourth Year'];
    if (!validYears.includes(year)) {
      return res.status(400).json({ success: false, message: 'Invalid year. Must be: ' + validYears.join(', ') });
    }

    // Validate category enum
    const validCategories = ['Front Lab', 'Ideal Lab'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ success: false, message: 'Invalid category. Must be: ' + validCategories.join(', ') });
    }

    // Check if roll number already exists
    const rollExists = await Student.findOne({ rollNumber: rollNumber.toUpperCase() });
    if (rollExists) {
      return res.status(400).json({ success: false, message: `Student with roll number ${rollNumber} already exists` });
    }

    // Check if email already exists
    const emailExists = await Student.findOne({ email });
    if (emailExists) {
      return res.status(400).json({ success: false, message: 'Student with this email already exists' });
    }

    const student = await Student.create({
      name,
      rollNumber: rollNumber.toUpperCase(),
      branch,
      section: section.toUpperCase(),
      email,
      year,
      category
    });

    invalidateStudentCache();

    res.status(201).json({
      success: true,
      data: student
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update student details
// @route   PUT /api/students/:id
// @access  Private (Admin only)
exports.updateStudent = async (req, res) => {
  try {
    const { name, rollNumber, branch, section, email, year, category } = req.body;

    let student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    // Validate year if provided
    if (year) {
      const validYears = ['First Year', 'Second Year', 'Third Year', 'Fourth Year'];
      if (!validYears.includes(year)) {
        return res.status(400).json({ success: false, message: 'Invalid year. Must be: ' + validYears.join(', ') });
      }
    }

    // Validate category if provided
    if (category) {
      const validCategories = ['Front Lab', 'Ideal Lab'];
      if (!validCategories.includes(category)) {
        return res.status(400).json({ success: false, message: 'Invalid category. Must be: ' + validCategories.join(', ') });
      }
    }

    // Check if updating roll number and if the new roll number is already taken
    if (rollNumber && rollNumber.toUpperCase() !== student.rollNumber) {
      const rollExists = await Student.findOne({ rollNumber: rollNumber.toUpperCase() });
      if (rollExists) {
        return res.status(400).json({ success: false, message: `Student with roll number ${rollNumber} already exists` });
      }
      student.rollNumber = rollNumber.toUpperCase();
    }

    // Check if updating email and if the new email is already taken
    if (email && email !== student.email) {
      const emailExists = await Student.findOne({ email });
      if (emailExists) {
        return res.status(400).json({ success: false, message: 'Student with this email already exists' });
      }
      student.email = email;
    }

    if (name) student.name = name;
    if (branch) student.branch = branch;
    if (section) student.section = section.toUpperCase();
    if (year) student.year = year;
    if (category) student.category = category;

    await student.save();

    invalidateStudentCache();

    res.status(200).json({
      success: true,
      data: student
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Delete student
// @route   DELETE /api/students/:id
// @access  Private (Admin only)
exports.deleteStudent = async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    // Delete student's attendance records first
    await Attendance.deleteMany({ student: student._id });

    // Delete student
    await Student.findByIdAndDelete(req.params.id);

    invalidateStudentCache();

    res.status(200).json({
      success: true,
      message: 'Student and associated attendance records deleted successfully'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Register student face embeddings using frames from webcam
// @route   POST /api/students/:id/register-faces
// @access  Private (Admin & Faculty)
exports.registerFaces = async (req, res) => {
  const studentId = req.params.id;
  try {
    const { images } = req.body; // Array of base64 images

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'Please provide face images' });
    }

    let student = await Student.findById(studentId);
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    if (student.isProcessingFaceRegistration) {
      return res.status(409).json({ success: false, message: 'Face registration is already in progress for this student.' });
    }

    // Lock the student record
    await Student.findByIdAndUpdate(studentId, { isProcessingFaceRegistration: true });

    console.log('\\n[FACE REGISTER] START');
    console.log(`[FACE REGISTER] Student ID: ${studentId}`);
    console.log(`[FACE REGISTER] Images received: ${images.length}`);

    // Call Python AI Service to extract embeddings
    const { postToAi } = require('../utils/aiClient');
    
    console.log(`[FACE REGISTER] Forwarding ${images.length} images to AI service...`);

    let result;
    try {
      result = await postToAi('/api/extract-embeddings', {
        student_id: student._id.toString(),
        roll_number: student.rollNumber,
        images: images
      }, 2); // 2 retries

      if (!result.success) {
        throw new Error(result.message || 'Error processing images in AI service');
      }
    } catch (aiError) {
      console.error(`[FACE REGISTER] AI Service Error:`, aiError.message);
      // Unlock before returning
      await Student.findByIdAndUpdate(studentId, { isProcessingFaceRegistration: false }).catch(()=>null);
      return res.status(502).json({
        success: false,
        message: aiError.message || 'AI face service unavailable'
      });
    }

    console.log(`[FACE REGISTER] Embeddings generated: ${result.embeddings.length}`);

    // Outlier filtering: remove any embedding that deviates significantly from centroid
    let cleanEmbeddings = result.embeddings;
    if (result.embeddings.length >= 5) {
      const centroid = new Array(128).fill(0);
      for (const emb of result.embeddings) {
        for (let k = 0; k < 128; k++) centroid[k] += emb[k];
      }
      for (let k = 0; k < 128; k++) centroid[k] /= result.embeddings.length;

      const filtered = result.embeddings.filter((emb) => {
        let dot = 0, n1 = 0, n2 = 0;
        for (let k = 0; k < 128; k++) {
          dot += emb[k] * centroid[k];
          n1 += emb[k] * emb[k];
          n2 += centroid[k] * centroid[k];
        }
        const dist = 1.0 - (dot / (Math.sqrt(n1) * Math.sqrt(n2)));
        return dist < 0.40;
      });

      if (filtered.length >= 5) {
        console.log(`[FACE REGISTER] Retained ${filtered.length}/${result.embeddings.length} clean embeddings (pruned ${result.embeddings.length - filtered.length} outliers).`);
        cleanEmbeddings = filtered;
      }
    }

    // Fix Mongoose VersionError using atomic update
    await Student.findByIdAndUpdate(
      studentId,
      {
        $set: {
          embeddings: cleanEmbeddings,
          isProcessingFaceRegistration: false
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    console.log(`[FACE REGISTER] MongoDB updated successfully for student ${studentId}\\n`);

    invalidateStudentCache();

    res.status(200).json({
      success: true,
      message: `Face registered successfully. Extracted ${result.embeddings.length} embeddings.`,
      embeddingCount: result.embeddings.length
    });

  } catch (error) {
    console.error(`[FACE REGISTER] Error:`, error);
    // Ensure we unlock on error if it was locked
    await Student.findByIdAndUpdate(studentId, { isProcessingFaceRegistration: false }).catch(()=>null);
    res.status(500).json({ success: false, message: error.message });
  }
};
