import os
import sys
import shutil
import urllib.request
import tarfile
import subprocess
import time

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))

# 1. ZeroGPU hook for Hugging Face Spaces
try:
    import spaces
    @spaces.GPU
    def zero_gpu_probe():
        return True
    zero_gpu_probe()
    print("[ZeroGPU] Hardware accelerator initialized successfully.")
except Exception as e:
    print(f"[ZeroGPU] Status/Fallback: {e}")

# 2. Ensure Node.js runtime is available on the container
NODE_DIR = "/tmp/node-v20"
node_path = shutil.which("node")

if not node_path and sys.platform.startswith("linux"):
    bin_node = os.path.join(NODE_DIR, "bin", "node")
    if not os.path.exists(bin_node):
        print("[Node Setup] Downloading standalone Node.js v20 for Linux...")
        node_url = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.gz"
        tar_dest = "/tmp/node.tar.gz"
        urllib.request.urlretrieve(node_url, tar_dest)
        with tarfile.open(tar_dest, "r:gz") as tar:
            tar.extractall("/tmp")
        extracted_name = "/tmp/node-v20.18.0-linux-x64"
        if os.path.exists(extracted_name):
            os.rename(extracted_name, NODE_DIR)
        print("[Node Setup] Node.js extracted successfully to", NODE_DIR)
    os.environ["PATH"] = f"{NODE_DIR}/bin:" + os.environ.get("PATH", "")
    node_path = os.path.join(NODE_DIR, "bin", "node")

print(f"[Node Setup] Active Node.js binary: {shutil.which('node') or node_path}")

# 3. Ensure Backend npm dependencies are installed
backend_dir = os.path.join(CURRENT_DIR, "backend")
node_modules_dir = os.path.join(backend_dir, "node_modules")

if not os.path.exists(node_modules_dir):
    print("[Backend Setup] Installing production dependencies for Node.js backend...")
    npm_cmd = shutil.which("npm") or "npm"
    subprocess.run([npm_cmd, "install", "--omit=dev"], cwd=backend_dir, check=True)

# 4. Start Python AI Service in background on port 8000
ai_service_dir = os.path.join(CURRENT_DIR, "ai_service")
print("[AI Service] Launching Python OpenCV AI Service on port 8000...")
ai_env = os.environ.copy()
ai_env["PORT"] = "8000"
ai_env["PYTHONUNBUFFERED"] = "1"
ai_proc = subprocess.Popen(
    [sys.executable, "app.py"],
    cwd=ai_service_dir,
    env=ai_env
)

time.sleep(2)

# 5. Start Node.js Express Backend on port 7860 (Hugging Face default port)
# Express serves the built React frontend at frontend/dist AND all backend API routes at /api
print("[Full-Stack Server] Launching Node.js Express Server on port 7860...")
backend_env = os.environ.copy()
backend_env["PORT"] = "7860"
backend_env["AI_SERVICE_URL"] = "http://127.0.0.1:8000"

node_bin = shutil.which("node") or "node"
backend_proc = subprocess.Popen(
    [node_bin, "src/server.js"],
    cwd=backend_dir,
    env=backend_env
)

print("\n" + "=" * 60)
print("🚀 Full-Stack Student Attendance System is running!")
print("   - React 19 Frontend: Serving from frontend/dist")
print("   - Node.js Express Backend: Listening on port 7860")
print("   - Python AI Engine: Listening on port 8000")
print("=" * 60 + "\n")

# 6. Keep orchestrator running and monitor child processes
try:
    while True:
        if backend_proc.poll() is not None:
            print("[CRITICAL] Backend process exited unexpectedly.")
            break
        if ai_proc.poll() is not None:
            print("[CRITICAL] AI Service process exited unexpectedly.")
            break
        time.sleep(2)
except KeyboardInterrupt:
    print("[Shutdown] Stopping full-stack services...")
    backend_proc.terminate()
    ai_proc.terminate()
    backend_proc.wait()
    ai_proc.wait()
