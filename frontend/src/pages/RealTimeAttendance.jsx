import { useState, useRef, useEffect, useCallback } from 'react';
import Webcam from 'react-webcam';
import {
  Scan,
  StopCircle,
  Play,
  CheckCircle,
  AlertCircle,
  Users,
  Volume2,
  VolumeX,
  UserCheck,
  Download,
  Trash2,
  ScanFace,
  RotateCcw,
  Clock
} from 'lucide-react';
import API from '../utils/api';

const RealTimeAttendance = () => {
  // Optimization constants to drastically reduce network payload and AI CPU load
  const RECOGNITION_CAPTURE_WIDTH = 480;
  const RECOGNITION_CAPTURE_HEIGHT = 360;

  const webcamRef = useRef(null);
  
  const [activeSession, setActiveSession] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [isInitializing, setIsInitializing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [attendanceList, setAttendanceList] = useState([]);
  const [detectedStudent, setDetectedStudent] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const pendingActionTimeoutRef = useRef(null);
  const cooldownsRef = useRef({});
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [cameraError, setCameraError] = useState(null);

  // Debug Diagnostics UI
  const [debugMode, setDebugMode] = useState(false);
  const [debugInfo, setDebugInfo] = useState({
    faceDetectorLoaded: 'YES',
    facesFound: 0,
    frameCaptured: 'NO',
    backendResponse: 'WAITING',
    aiResponse: 'WAITING'
  });

  // Handle Speech Feedback
  const speakText = useCallback((text) => {
    if (!speechEnabled || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = 1;
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  }, [speechEnabled]);

  // Offline & Network resilience
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [networkNotice, setNetworkNotice] = useState(null);

  // Auto-discover any active session on mount
  useEffect(() => {
    let isMounted = true;

    // Check localStorage fallback for offline survival
    try {
      const cachedSession = localStorage.getItem('active_attendance_session');
      if (cachedSession) {
        const parsed = JSON.parse(cachedSession);
        if (parsed && parsed.status === 'active') {
          setActiveSession(parsed);
          setScanning(true);
        }
      }
      const cachedList = localStorage.getItem('active_attendance_list');
      if (cachedList) {
        setAttendanceList(JSON.parse(cachedList));
      }
    } catch (e) {
      console.warn('LocalStorage read warning:', e);
    }

    const fetchExistingSession = async () => {
      try {
        const res = await API.get('/attendance/session/active');
        if (isMounted && res.data && res.data.success) {
          if (res.data.data) {
            console.log('[SESSION] Resumed active session:', res.data.data.sessionName);
            setActiveSession(res.data.data);
            if (Array.isArray(res.data.attendees)) {
              setAttendanceList(res.data.attendees);
              try { localStorage.setItem('active_attendance_list', JSON.stringify(res.data.attendees)); } catch(e){}
            }
            try { localStorage.setItem('active_attendance_session', JSON.stringify(res.data.data)); } catch(e){}
            setScanning(true);
          } else {
            // No session active in database
            setActiveSession(null);
            setScanning(false);
            localStorage.removeItem('active_attendance_session');
            localStorage.removeItem('active_attendance_list');
          }
        }
      } catch (e) {
        console.warn('[SESSION] Note checking active session:', e.message);
      }
    };

    fetchExistingSession();

    // Online & Offline Event Listeners
    const handleOnline = () => {
      setIsOffline(false);
      setNetworkNotice('Connection restored! Resuming live scanner...');
      setTimeout(() => setNetworkNotice(null), 4000);
      fetchExistingSession();
    };

    const handleOffline = () => {
      setIsOffline(true);
      setNetworkNotice('Network connection issue detected. Scanner is paused. Session data is safe.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      isMounted = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Multi-device sync: Sync active session state across laptops periodically
  useEffect(() => {
    if (!activeSession || activeSession.status !== 'active' || isOffline) return;
    const syncInterval = setInterval(async () => {
      try {
        const res = await API.get('/attendance/session/active');
        if (res.data && res.data.success) {
          if (res.data.data && res.data.data._id === activeSession._id) {
            if (Array.isArray(res.data.attendees) && res.data.attendees.length !== attendanceList.length) {
              setAttendanceList(res.data.attendees);
              try { localStorage.setItem('active_attendance_list', JSON.stringify(res.data.attendees)); } catch(e){}
            }
          } else if (!res.data.data) {
            // Session was terminated on another device
            setActiveSession(prev => prev ? { ...prev, status: 'completed' } : null);
            setScanning(false);
            localStorage.removeItem('active_attendance_session');
          }
        }
      } catch (e) {
        // network issue - do not clear local state
      }
    }, 5000);
    return () => clearInterval(syncInterval);
  }, [activeSession, isOffline, attendanceList.length]);

  // Handle Start Session (strictly requires user to enter a session name)
  const handleStartSession = async () => {
    if (!sessionName || !sessionName.trim()) {
      alert('Please enter a session name before starting the scanner.');
      return;
    }
    
    try {
      setIsInitializing(true);
      const res = await API.post('/attendance/session/start', {
        sessionName: sessionName.trim()
      });
      
      if (res.data.success) {
        setActiveSession(res.data.data);
        setAttendanceList([]);
        setDetectedStudent(null);
        setScanning(true);
        setSessionName('');
        try {
          localStorage.setItem('active_attendance_session', JSON.stringify(res.data.data));
          localStorage.setItem('active_attendance_list', JSON.stringify([]));
        } catch(e){}
      }
    } catch (err) {
      console.error('Error starting session:', err);
      alert(err.response?.data?.message || err.message || 'Failed to start session');
    } finally {
      setIsInitializing(false);
    }
  };

  // Handle Stop Session
  const handleStopSession = async () => {
    if (isStopping || !activeSession) return;
    
    try {
      setIsStopping(true);
      setScanning(false);
      const res = await API.post('/attendance/session/stop', { sessionId: activeSession._id });
      if (res.data.success) {
        const finalized = {
          ...activeSession,
          status: 'completed',
          presentCount: res.data.presentCount,
          absentCount: res.data.absentCount,
          excelUrl: res.data.excelUrl
        };
        setActiveSession(finalized);
        try {
          localStorage.removeItem('active_attendance_session');
          localStorage.removeItem('active_attendance_list');
        } catch(e){}
      }
    } catch (err) {
      console.error('Error stopping session:', err);
      alert('Failed to stop session');
    } finally {
      setIsStopping(false);
    }
  };

  // Handle Download Excel
  const handleDownloadExcel = async () => {
    try {
      const res = await API.get(`/attendance/session/${activeSession._id}/excel`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${activeSession.sessionId}_Report.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      console.error('Error downloading excel:', err);
      alert('Failed to download Excel report');
    }
  };

  // Handle Clear Session
  const handleClearSession = async () => {
    if (!window.confirm('Are you sure you want to delete this active session and all its data?')) return;
    try {
      const res = await API.delete('/attendance/session/active', { data: { sessionId: activeSession._id } });
      if (res.data.success) {
        setScanning(false);
        setActiveSession(null);
        setAttendanceList([]);
        setDetectedStudent(null);
        alert('Session data cleared');
      }
    } catch (err) {
      console.error('Error clearing session:', err);
      alert('Failed to clear session');
    }
  };

  const handleConfirmAction = async (actionType) => {
    if (!pendingAction || isConfirming) return;
    
    try {
      setIsConfirming(true);
      const student = pendingAction.student;
      const response = await API.post('/attendance/activity-confirm', {
        studentId: student.id,
        sessionId: activeSession._id,
        action: actionType,
        image: pendingAction.image
      });
      
      if (response.data.success) {
        setAttendanceList(prev => {
          const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
          const updated = [{ 
            name: student.name, 
            rollNumber: student.rollNumber || student.id, 
            id: student.id, 
            type: actionType, 
            time: timeStr 
          }, ...prev];
          try { localStorage.setItem('active_attendance_list', JSON.stringify(updated)); } catch(e){}
          return updated;
        });
        
        if (actionType === 'LOGIN') {
          if (speakText) speakText(`Login recorded for ${student.name}`);
        } else {
          if (speakText) speakText(`Logout recorded for ${student.name}`);
        }
      }
    } catch (err) {
      console.error('Action confirmation failed', err);
    } finally {
      setIsConfirming(false);
      cooldownsRef.current[pendingAction.student.id] = Date.now();
      setPendingAction(null);
      if (pendingActionTimeoutRef.current) {
        clearTimeout(pendingActionTimeoutRef.current);
        pendingActionTimeoutRef.current = null;
      }
    }
  };

  const isScanningRef = useRef(false);
  const loopTimeoutRef = useRef(null);
  const isRequestPendingRef = useRef(false);
  const activeSessionRef = useRef(null);
  const recognitionHoldRef = useRef({ studentId: null, timestamp: 0 });

  useEffect(() => {
    activeSessionRef.current = activeSession;
    isScanningRef.current = scanning && activeSession && activeSession.status === 'active';
  }, [scanning, activeSession]);

  const scanFrame = useCallback(async () => {
    if (isOffline || !navigator.onLine) {
      loopTimeoutRef.current = setTimeout(() => scanFrame(), 1500);
      return;
    }

    if (!isScanningRef.current) {
      if (scanning && activeSession && activeSession.status === 'active') {
        loopTimeoutRef.current = setTimeout(() => scanFrame(), 300);
      } else {
        setDetectedStudent(null);
      }
      return;
    }

    if (!webcamRef.current) {
      loopTimeoutRef.current = setTimeout(() => scanFrame(), 300);
      return;
    }

    try {
      const imageSrc = webcamRef.current.getScreenshot({ width: RECOGNITION_CAPTURE_WIDTH, height: RECOGNITION_CAPTURE_HEIGHT });
      if (!imageSrc) {
        setDebugInfo(prev => ({ ...prev, frameCaptured: 'NO' }));
        return;
      }
      
      setDebugInfo(prev => ({ 
        ...prev, 
        frameCaptured: 'YES', 
        backendResponse: 'Sending...',
        aiResponse: 'Waiting...'
      }));

      // Send sessionId to enforce session boundaries
      const response = await API.post('/attendance/recognize', { 
        image: imageSrc,
        sessionId: activeSession._id
      });
      const result = response.data;

      setDebugInfo(prev => ({
        ...prev,
        backendResponse: response.status === 200 ? '200 OK' : 'Error',
        aiResponse: result.message || 'Success',
        facesFound: result.faceDetected ? 1 : 0
      }));

      if (!result.faceDetected) {
        if (Date.now() - recognitionHoldRef.current.timestamp < 1000) {
          console.log("[STABILITY] Holding previous identity (no face)");
          return;
        }
        console.log("[STABILITY] Identity cleared");
        setDetectedStudent(null);
        return;
      }

      if (result.matched) {
        if (recognitionHoldRef.current.studentId !== result.studentId) {
          console.log("[STABILITY] Identity locked: " + result.name);
        }
        recognitionHoldRef.current = { studentId: result.studentId, timestamp: Date.now() };

        setDetectedStudent({
          name: result.name,
          rollNumber: result.rollNumber || result.studentId,
          id: result.studentId,
          confidence: Math.round(result.confidence * 100)
        });

        const lastPopupTime = cooldownsRef.current[result.studentId];
        const inCooldown = lastPopupTime && (Date.now() - lastPopupTime < 2000);

        setPendingAction(prevPending => {
          if (!inCooldown && !prevPending && result.action && result.action !== 'IGNORE') {
            const nextAction = {
              type: result.action,
              student: { 
                name: result.name, 
                rollNumber: result.rollNumber || result.studentId, 
                id: result.studentId 
              },
              image: imageSrc
            };
            
            if (result.action === 'LOGOUT_AVAILABLE') {
              if (pendingActionTimeoutRef.current) clearTimeout(pendingActionTimeoutRef.current);
              pendingActionTimeoutRef.current = setTimeout(() => {
                cooldownsRef.current[result.studentId] = Date.now();
                setPendingAction(null);
              }, 8000);
            }
            return nextAction;
          }
          return prevPending;
        });
      } else {
        // Unknown or ambiguous face: immediately reset hold so previous student name isn't shown
        recognitionHoldRef.current = { studentId: null, timestamp: 0 };
        console.log("[STABILITY] Identity cleared (unknown face in frame)");
        setDetectedStudent({
          name: "Unknown",
          id: "-",
          confidence: result.confidence ? Math.round(result.confidence * 100) : 0,
          message: result.message,
          isCooldown: false
        });
      }

    } catch (err) {
      console.error('Scan API error:', err);
      if (err.message && (err.message.includes('Network') || err.message.includes('timeout') || !navigator.onLine)) {
        setIsOffline(true);
        setNetworkNotice('Network connection issue. Waiting to reconnect...');
      }
      setDebugInfo(prev => ({ ...prev, backendResponse: 'Failed' }));
    } finally {
      if (isScanningRef.current || (scanning && activeSession && activeSession.status === 'active')) {
        // Phase 5: Reduce frontend idle timeout to execute fast sequential requests
        loopTimeoutRef.current = setTimeout(() => scanFrame(), 300);
      } else {
        setDetectedStudent(null);
      }
    }
  }, [speakText, activeSession, scanning, isOffline]);

  useEffect(() => {
    if (scanning && activeSession && activeSession.status === 'active') {
      scanFrame();
    } else {
      setDetectedStudent(null);
    }
    return () => {
      if (loopTimeoutRef.current) {
        clearTimeout(loopTimeoutRef.current);
      }
    };
  }, [scanning, scanFrame, activeSession]);

  return (
    <div className="space-y-8 animate-fade-in-up">
      {/* Offline Alert Banner */}
      {isOffline && (
        <div className="bg-amber-500/10 border-2 border-amber-500/30 text-amber-900 rounded-2xl p-4 flex items-center justify-between shadow-sm animate-pulse">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0" />
            <div>
              <h4 className="font-bold text-sm text-amber-900">Network Issue Detected</h4>
              <p className="text-xs text-amber-700">Scanner is paused. Active session and recorded attendees are safely stored and will not be lost. Reconnecting automatically...</p>
            </div>
          </div>
          <span className="text-xs font-bold bg-amber-200 text-amber-800 px-3 py-1 rounded-full uppercase tracking-wider">OFFLINE</span>
        </div>
      )}

      {networkNotice && !isOffline && (
        <div className="bg-emerald-500/10 border-2 border-emerald-500/30 text-emerald-900 rounded-2xl p-4 flex items-center gap-3 shadow-sm">
          <CheckCircle className="h-5 w-5 text-emerald-600 flex-shrink-0" />
          <span className="font-bold text-sm text-emerald-800">{networkNotice}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <div className="flex items-center justify-center rounded-lg bg-brand-50 p-1.5 text-brand-600">
              <ScanFace className="h-4 w-4" />
            </div>
            <span className="text-xs font-bold uppercase tracking-widest text-brand-600">Live AI Engine</span>
          </div>
          <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight sm:text-3xl">Real-Time Scanner</h2>
          <p className="mt-1 text-sm font-medium text-slate-500">Capture face data streams to automatically mark attendance.</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setSpeechEnabled(!speechEnabled)}
            className={`flex h-12 w-12 items-center justify-center rounded-2xl border transition-all shadow-sm active:scale-95 ${
              speechEnabled
                ? 'border-brand-200 bg-brand-50 text-brand-600 hover:bg-brand-100 shadow-brand-500/10'
                : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-50'
            }`}
            title={speechEnabled ? 'Voice Assist On' : 'Voice Assist Muted'}
          >
            {speechEnabled ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
          </button>

          {!activeSession && (
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  placeholder="Enter Session Name (e.g. CSE-A Lab)"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  disabled={isInitializing}
                  className="px-4 py-3 text-sm font-semibold text-slate-800 bg-white border border-slate-200 rounded-2xl shadow-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 w-full sm:w-64 transition-all placeholder:text-slate-400"
                />
                <button
                  onClick={handleStartSession}
                  disabled={isInitializing}
                  className="group flex items-center justify-center gap-2.5 rounded-2xl px-6 py-3.5 text-sm font-extrabold text-white shadow-lg transition-all active:scale-95 bg-emerald-500 hover:bg-emerald-400 shadow-emerald-500/30 disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  <Play className="h-5 w-5" />
                  <span>{isInitializing ? 'INITIALIZING...' : 'INITIALIZE SCANNER'}</span>
                </button>
              </div>
            )}

          {activeSession && activeSession.status === 'active' && (
            <>
              <button
                onClick={handleStopSession}
                disabled={isStopping}
                className={`group flex items-center justify-center gap-2.5 rounded-2xl px-6 py-3.5 text-sm font-extrabold text-white shadow-lg transition-all ${isStopping ? 'bg-rose-400 opacity-80 cursor-not-allowed' : 'active:scale-95 bg-rose-500 hover:bg-rose-400 shadow-rose-500/30'}`}
              >
                <StopCircle className={`h-5 w-5 ${isStopping ? 'animate-spin' : 'animate-pulse'}`} />
                <span>{isStopping ? 'TERMINATING...' : 'TERMINATE SESSION'}</span>
              </button>
              
              <button
                onClick={handleClearSession}
                className="flex items-center justify-center gap-2.5 rounded-2xl px-5 py-3.5 text-sm font-extrabold text-slate-700 shadow-md transition-all active:scale-95 bg-slate-200 hover:bg-slate-300"
                title="Clear current session data"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            </>
          )}

          {activeSession && activeSession.status === 'completed' && (
            <>
              <button
                onClick={handleDownloadExcel}
                className="flex items-center justify-center gap-2.5 rounded-2xl px-6 py-3.5 text-sm font-extrabold text-white shadow-lg transition-all active:scale-95 bg-blue-500 hover:bg-blue-400 shadow-blue-500/30"
              >
                <Download className="h-5 w-5" />
                <span>EXPORT SHEET</span>
              </button>
              
              <button
                onClick={() => { setActiveSession(null); setAttendanceList([]); }}
                className="flex items-center justify-center gap-2.5 rounded-2xl px-6 py-3.5 text-sm font-extrabold text-slate-700 shadow-md transition-all active:scale-95 bg-white border border-slate-200 hover:bg-slate-50"
              >
                <RotateCcw className="h-5 w-5" />
                <span>RESET ENGINE</span>
              </button>
            </>
          )}

        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* WEBCAM COLUMN */}
        <div className="glass-card p-8 bg-white lg:col-span-2 flex flex-col items-center space-y-6">
          
          <div className="w-full flex justify-between items-center bg-slate-50 p-4 rounded-xl border border-slate-100 mb-2">
            <span className="font-extrabold text-slate-500 uppercase text-[11px] tracking-widest">Engine Status</span>
            <span className={`font-black uppercase text-[10px] tracking-widest px-3 py-1.5 rounded-md ${
              !activeSession ? 'bg-slate-200 text-slate-600' :
              activeSession.status === 'active' ? 'bg-emerald-100 text-emerald-700 animate-pulse' : 'bg-blue-100 text-blue-700'
            }`}>
              {!activeSession ? 'OFFLINE' : 
               activeSession.status === 'active' ? `LIVE: ${activeSession.sessionName || activeSession.sessionId}` : 'FINALIZED'}
            </span>
          </div>

          <div className="relative w-full overflow-hidden rounded-3xl bg-slate-950 border-4 border-slate-900 shadow-[0_0_40px_rgba(0,0,0,0.1)] flex items-center justify-center aspect-video">
            
            {cameraError && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center text-center p-6 bg-slate-900/95 backdrop-blur-md">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-500 mb-4 border border-rose-500/20">
                  <AlertCircle className="h-8 w-8" />
                </div>
                <span className="text-base font-extrabold text-white">Camera Access Failed</span>
                <span className="text-xs text-rose-300 mt-2 max-w-xs">{cameraError}</span>
              </div>
            )}

            {(!scanning || !activeSession || activeSession.status !== 'active') && !cameraError && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center text-center p-4 bg-slate-900/70 backdrop-blur-sm">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-white mb-4 shadow-lg border border-white/20">
                  <Scan className="h-8 w-8" />
                </div>
                
                {activeSession && activeSession.status === 'completed' ? (
                  <>
                    <span className="text-base font-extrabold text-white tracking-wide">Attendance Completed</span>
                    <div className="mt-4 flex gap-4">
                      <div className="bg-emerald-500/20 border border-emerald-400/50 px-4 py-2 rounded-xl flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-emerald-400" />
                        <span className="text-emerald-50 font-bold">Present: {activeSession.presentCount}</span>
                      </div>
                      <div className="bg-rose-500/20 border border-rose-400/50 px-4 py-2 rounded-xl flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-rose-400" />
                        <span className="text-rose-50 font-bold">Absent: {activeSession.absentCount}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-base font-extrabold text-white tracking-wide">Scanner Offline</span>
                    <span className="text-sm text-slate-300 mt-2 max-w-xs">
                      Enter a session name above and click <span className="text-emerald-400 font-bold">INITIALIZE SCANNER</span> to start.
                    </span>
                  </>
                )}
              </div>
            )}

            <Webcam
              audio={false}
              ref={webcamRef}
              screenshotFormat="image/jpeg"
              videoConstraints={{ width: 1280, height: 720, facingMode: "user" }}
              onUserMediaError={(err) => setCameraError("Cannot access webcam. Please check permissions or hardware.")}
              className="absolute inset-0 h-full w-full object-cover scale-x-[-1]"
            />
            
            {/* UI Reticles & Overlays when active */}
            {scanning && activeSession && activeSession.status === 'active' && !cameraError && (
              <>
                {/* Safe zone overlay */}
                <div className="absolute inset-0 z-10 pointer-events-none">
                  <div className="absolute inset-[10%] border-2 border-dashed border-white/20 rounded-3xl"></div>
                  <div className="absolute top-[10%] left-[10%] w-8 h-8 border-t-4 border-l-4 border-emerald-400/80 rounded-tl-2xl"></div>
                  <div className="absolute top-[10%] right-[10%] w-8 h-8 border-t-4 border-r-4 border-emerald-400/80 rounded-tr-2xl"></div>
                  <div className="absolute bottom-[10%] left-[10%] w-8 h-8 border-b-4 border-l-4 border-emerald-400/80 rounded-bl-2xl"></div>
                  <div className="absolute bottom-[10%] right-[10%] w-8 h-8 border-b-4 border-r-4 border-emerald-400/80 rounded-br-2xl"></div>
                </div>

                {/* Scanline effect */}
                <div className="absolute inset-0 z-10 pointer-events-none bg-gradient-to-b from-transparent via-emerald-400/10 to-transparent w-full h-[10%] animate-[scan_3s_ease-in-out_infinite]"></div>
              </>
            )}

            {/* User Requested Debug Mode Panel */}
            {debugMode && (
              <div className="absolute top-5 right-5 z-40 bg-black/80 text-emerald-400 font-mono text-[10px] p-4 rounded-xl border border-emerald-500/30 flex flex-col gap-1.5 w-64 shadow-2xl backdrop-blur-md pointer-events-none">
                <div className="border-b border-emerald-500/30 pb-2 mb-2 font-black text-white tracking-widest uppercase text-[9px]">Live Diagnostics</div>
                <div className="flex justify-between"><span>AI Engine:</span> <span className="text-white">{debugInfo.faceDetectorLoaded}</span></div>
                <div className="flex justify-between"><span>Camera Link:</span> <span className="text-white">{scanning ? 'ACTIVE' : 'IDLE'}</span></div>
                <div className="flex justify-between"><span>Buffer Rate:</span> <span className="text-white">{scanning ? '1 FPS' : '0 FPS'}</span></div>
                <div className="flex justify-between"><span>Faces Found:</span> <span className="text-white">{debugInfo.facesFound}</span></div>
                <div className="flex justify-between"><span>Recognized:</span> <span className="text-white">{detectedStudent && detectedStudent.name !== 'Unknown' ? 'YES' : 'NO'}</span></div>
                <div className="flex justify-between truncate" title={debugInfo.backendResponse}><span>REST API:</span> <span className="text-white">{debugInfo.backendResponse === '200 OK' ? 'CONNECTED' : 'WAITING'}</span></div>
                <div className="flex justify-between"><span>DB Link:</span> <span className="text-white">SECURE</span></div>
                <div className="flex justify-between border-t border-emerald-500/30 pt-1.5 mt-1.5"><span>Entities Logged:</span> <span className="text-white font-bold">{attendanceList.length}</span></div>
              </div>
            )}

            {/* Action Popup UI */}
            {pendingAction && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm rounded-3xl animate-in fade-in zoom-in-95 duration-200">
                <div className="bg-white p-6 rounded-2xl shadow-2xl flex flex-col items-center max-w-sm w-full mx-4 border border-slate-100 text-center">
                  <div className="h-16 w-16 bg-brand-50 text-brand-600 rounded-full flex items-center justify-center mb-4">
                    <ScanFace className="h-8 w-8" />
                  </div>
                  <h3 className="text-xl font-black text-slate-900 mb-0.5">{pendingAction.student.name}</h3>
                  <div className="text-xs font-bold text-slate-400 mb-4 font-mono">
                    {pendingAction.student.rollNumber || pendingAction.student.id}
                  </div>
                  <p className="text-sm font-medium text-slate-500 mb-6">
                    {pendingAction.type === 'LOGIN_AVAILABLE' ? 'Ready to log in?' : 'Do you want to log out?'}
                  </p>
                  <div className="flex gap-3 w-full">
                    <button 
                      onClick={() => {
                        cooldownsRef.current[pendingAction.student.id] = Date.now();
                        setPendingAction(null);
                        if (pendingActionTimeoutRef.current) clearTimeout(pendingActionTimeoutRef.current);
                      }}
                      className="flex-1 py-3 px-4 rounded-xl font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={() => handleConfirmAction(pendingAction.type === 'LOGIN_AVAILABLE' ? 'LOGIN' : 'LOGOUT')}
                      disabled={isConfirming}
                      className={`flex-1 py-3 px-4 rounded-xl font-bold text-white transition-all active:scale-95 ${isConfirming ? 'opacity-50 cursor-not-allowed' : ''} ${pendingAction.type === 'LOGIN_AVAILABLE' ? 'bg-emerald-500 hover:bg-emerald-400 shadow-emerald-500/30 shadow-lg' : 'bg-rose-500 hover:bg-rose-400 shadow-rose-500/30 shadow-lg'}`}
                    >
                      {pendingAction.type === 'LOGIN_AVAILABLE' ? 'LOGIN' : 'LOG OUT'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Warning if scanning but no face detected */}
            {scanning && !cameraError && debugInfo.facesFound === 0 && (
              <div className="absolute top-5 left-5 z-40 bg-rose-500/90 backdrop-blur text-white font-bold text-[10px] uppercase tracking-widest px-4 py-2.5 rounded-lg shadow-xl animate-pulse border border-rose-400/50 flex items-center gap-2">
                <AlertCircle className="h-3.5 w-3.5" />
                Waiting for target...
              </div>
            )}
          </div>
        </div>

        {/* SIDEBAR COLUMN */}
        <div className="space-y-6">
          
          {/* Detected Student Card */}
          <div className="glass-card p-8 bg-white border-b-4 border-brand-500 relative overflow-hidden">
            {detectedStudent && detectedStudent.name !== 'Unknown' && (
               <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full bg-emerald-500/10 blur-2xl"></div>
            )}
            
            <h3 className="text-[11px] font-extrabold text-slate-400 uppercase tracking-widest mb-5 flex items-center gap-2">
              <UserCheck className="h-4 w-4" />
              Current Target
            </h3>
            
            {detectedStudent ? (
              <div className="space-y-4 relative z-10">
                <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100">
                  <span className="block text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">Identity</span>
                  <span className={`block font-black text-xl truncate ${detectedStudent.name === 'Unknown' ? 'text-rose-500' : 'text-slate-900'}`}>
                    {detectedStudent.name}
                  </span>
                  {detectedStudent.message && detectedStudent.name === 'Unknown' && (
                    <span className="block text-xs font-bold text-rose-500 mt-2 whitespace-normal">
                      {detectedStudent.message}
                    </span>
                  )}
                  {detectedStudent.isCooldown && (
                    <span className="block text-xs font-bold text-amber-500 mt-2 whitespace-normal flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Cooldown Active
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100">
                    <span className="block text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">Roll No.</span>
                    <span className="block font-bold text-sm text-slate-700 truncate">
                      {detectedStudent.rollNumber || detectedStudent.id}
                    </span>
                  </div>
                  <div className="bg-slate-50/50 p-4 rounded-xl border border-slate-100">
                    <span className="block text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">Match %</span>
                    <span className={`block font-black text-sm ${detectedStudent.name === 'Unknown' ? 'text-rose-500' : 'text-emerald-600'}`}>{detectedStudent.confidence}%</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-center p-6 border-2 border-dashed border-slate-200 bg-slate-50/50 rounded-2xl h-48">
                <ScanFace className="h-10 w-10 text-slate-300 mb-3" />
                <span className="text-xs font-bold text-slate-500">Scanning environment...</span>
              </div>
            )}
          </div>

          {/* Attendance List */}
          <div className="glass-card p-8 bg-white flex flex-col h-[340px]">
             <h3 className="text-[11px] font-extrabold text-slate-400 uppercase tracking-widest mb-5 flex items-center gap-2">
              <Users className="h-4 w-4" />
              {activeSession ? `Session Log` : 'Activity Log'}
            </h3>

            <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin scrollbar-thumb-slate-200">
              {attendanceList.length === 0 ? (
                <div className="text-center text-xs font-medium text-slate-400 mt-16 flex flex-col items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-slate-50 flex items-center justify-center text-slate-300">
                    <Users className="h-5 w-5" />
                  </div>
                  No identities logged yet.
                </div>
              ) : (
                attendanceList.map((student, idx) => (
                  <div key={`${student.id}-${idx}`} className={`flex items-center justify-between p-3.5 rounded-xl border shadow-sm animate-fade-in-up ${student.type === 'LOGOUT' ? 'bg-rose-50 text-rose-900 border-rose-100' : 'bg-emerald-50 text-emerald-900 border-emerald-100'}`}>
                    <div className="flex items-center gap-3 truncate">
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-bold text-xs ${student.type === 'LOGOUT' ? 'bg-rose-200/50 text-rose-700' : 'bg-emerald-200/50 text-emerald-700'}`}>
                        {student.name[0]}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-extrabold text-sm truncate">{student.name}</span>
                        <span className="text-[10px] font-bold text-slate-500">{student.time || new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                      </div>
                    </div>
                    <div className={`flex items-center gap-1.5 bg-white px-2 py-1 rounded-md shadow-sm border shrink-0 ${student.type === 'LOGOUT' ? 'border-rose-50' : 'border-emerald-50'}`}>
                      {student.type === 'LOGOUT' ? (
                        <>
                          <div className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                          <span className="text-[10px] font-bold text-rose-600 uppercase tracking-wider">LOGOUT</span>
                        </>
                      ) : (
                        <>
                          <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                          <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider">LOGIN</span>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
};

export default RealTimeAttendance;
