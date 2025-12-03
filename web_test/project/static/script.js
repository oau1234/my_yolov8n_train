// ==========================================
// GHI CHÚ  - FRONTEND
// File này điều khiển hành vi client-side (JS):
// - Bắt sự kiện chọn file, hiển thị preview ảnh gốc
// - Gửi Form tới API `/upload` (multipart/form-data)
// - Nhận JSON trả về: { processed_image_url, counts, total_seconds, status }
// - Khi ảnh xử lý tải xong sẽ: hiển thị ảnh, cập nhật ô đếm (6 lớp), cập nhật thời gian và đèn trạng thái
// ==========================================

// ==========================================
// DOM Elements
// Lấy ra toàn bộ các phần tử HTML cần dùng bằng ID
// NOTE: Các biến này liên kết trực tiếp với UI để cập nhật giao diện
// ==========================================
const form = document.getElementById("yoloForm");
const imageInput = document.getElementById("imageInput");
const fileNameDisplay = document.getElementById("fileName");

const confSlider = document.getElementById("confSlider");  // Slider điều chỉnh CONF
const iouSlider = document.getElementById("iouSlider");    // Slider điều chỉnh IOU
const confVal = document.getElementById("confVal");        // Hiển thị giá trị CONF
const iouVal = document.getElementById("iouVal");          // Hiển thị giá trị IOU

const originalImg = document.getElementById("originalImg");    // ảnh gốc preview
const processedImg = document.getElementById("processedImg");  // ảnh đã xử lý YOLO
const cameraPreview = document.getElementById('cameraPreview');
const cameraCaptureBtn = document.getElementById('cameraCaptureBtn');

const downloadBtn = document.getElementById("downloadBtn");    // nút download ảnh xử lý

const loading = document.getElementById("loading");            // animation loading
const errorMessage = document.getElementById("errorMessage");  // khung hiển thị lỗi

// Các đèn LED trạng thái
// NOTE: CSS có .active để bật/tắt
const statusRed = document.getElementById("statusRed");
const statusYellow = document.getElementById("statusYellow");
const statusGreen = document.getElementById("statusGreen");

// Hiển thị thời gian xử lý client/server
const timeDisplay = document.getElementById("timeDisplay");

// Lấy các ID cho hiển thị thời gian đèn (bên trong traffic-light-item)
// NOTE: Các ID này nằm bên trong các đèn và sẽ được cập nhật bởi server
// khi trả về red_seconds, yellow_seconds, green_seconds

// ==========================================
// STATUS LIGHT CONTROL - KHÔNG SỬ DỤNG NỮA
// NOTE: 3 đèn luôn sáng (class "active" luôn có trong HTML)
// Chỉ cập nhật thời gian hiển thị trên mỗi đèn
// ==========================================
function setStatus(status) {
    // Giữ nguyên - 3 đèn luôn có class "active" và luôn sáng
    // Hàm này giữ lại chỉ để tương thích (không làm gì cả)
}

// ==========================================
// TIME DISPLAY - CẬP NHẬT THỜI GIAN CHO CÁC ĐÈN
// NOTE: Cập nhật các ID #greenTime, #yellowTime, #redTime
// ==========================================
function updateLightTimes(greenSec, yellowSec, redSec) {
    // Cập nhật thời gian hiển thị trên mỗi đèn
    const elGreen = document.getElementById('greenTime');
    const elYellow = document.getElementById('yellowTime');
    const elRed = document.getElementById('redTime');
    
    if (elGreen) elGreen.textContent = `${greenSec}s`;
    if (elYellow) elYellow.textContent = `${yellowSec}s`;
    if (elRed) elRed.textContent = `${redSec}s`;
}

// ==========================================
// DENSITY DISPLAY - CẬP NHẬT MẬT ĐỘ XE
// NOTE: Hiển thị tổng số xe và phân loại mức độ
// ==========================================
function updateDensity(totalVehicles) {
    const totalEl = document.getElementById('totalVehicles');
    const levelEl = document.getElementById('densityLevel');
    
    if (totalEl) totalEl.textContent = totalVehicles;
    
    let level = '—';
    if (totalVehicles < 5) level = '🟢 Ít';
    else if (totalVehicles <= 10) level = '🟡 Trung bình';
    else if (totalVehicles <= 15) level = '🟠 Khá';
    else level = '🔴 Đông';
    
    if (levelEl) levelEl.textContent = level;
}

// =========================
// CAMERA - server-side stream & capture (Raspberry Pi / USB camera)
// - Stream served from server at `/camera_stream` (MJPEG)
// - Capture endpoint `/camera_capture` triggers server to grab one frame from /dev/video0
// ==========================================

function startCamera() {
    // Start showing server-side MJPEG stream
    if (cameraPreview) cameraPreview.src = '/camera_stream';
}

function stopCamera() {
    if (cameraPreview) cameraPreview.src = '';
}

async function captureFrameAndSend() {
    try {
        // Ask server to capture a single frame from the connected USB camera
        const res = await fetch('/camera_capture', { method: 'POST' });
        if (!res.ok) throw new Error('Camera capture failed: ' + res.status);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const imageUrl = data.image_url; // full external URL from server

        // Set original preview to captured image and trigger upload by URL
        if (originalImg) {
            originalImg.src = imageUrl + '?t=' + Date.now();
            originalImg.classList.add('active');
        }

        const imageUrlInput = document.getElementById('imageUrlInput');
        if (imageUrlInput) imageUrlInput.value = imageUrl;

        // Automatically send to /upload using the image_url field so server will use saved frame
        await uploadByImageUrl(imageUrl);
    } catch (err) {
        console.error(err);
        showError('Lỗi khi chụp ảnh từ camera: ' + (err.message || err));
    }
}

// Send a Blob (from camera capture) to /upload, reuse handling similar to form submit
async function sendImageBlob(blob, filename) {
    loading.style.display = 'block';
    startTimer();
    form.querySelector('.btn-primary').disabled = true;
    const formData = new FormData();
    formData.append('image', blob, filename);
    formData.append('conf', confSlider.value);
    formData.append('iou', iouSlider.value);

    try {
        const res = await fetch('/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error('Server error: ' + res.status);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const processedUrl = data.processed_image_url + '?t=' + Date.now();
        // update main processed image
        if (processedImg) {
            processedImg.onload = () => processedImg.classList.add('active');
            processedImg.src = processedUrl;
        }

        // update counts and density
        let totalVehicles = 0;
        if (data.counts && Array.isArray(data.counts)) {
            for (let i = 0; i < data.counts.length; i++) {
                const countEl = document.getElementById(`count-${i}`);
                if (countEl) countEl.textContent = data.counts[i];
                totalVehicles += data.counts[i];
            }
        }
        updateDensity(totalVehicles);

        // update light times
        if (typeof data.red_seconds === 'number') {
            const r = Number(data.red_seconds);
            const y = Number(data.yellow_seconds || 3);
            const g = Number(data.green_seconds || Math.max(0, r - y));
            updateLightTimes(g, y, r);
        }

    } catch (err) {
        console.error(err);
        showError('Lỗi khi gửi ảnh từ camera: ' + (err.message || err));
    } finally {
        loading.style.display = 'none';
        form.querySelector('.btn-primary').disabled = false;
        stopTimer();
    }
}

// hook camera buttons
// Camera stream is always running (server-side). Start it when DOM is ready.
window.addEventListener('DOMContentLoaded', () => {
    try { startCamera(); } catch (e) { /* ignore */ }
});
if (cameraCaptureBtn) cameraCaptureBtn.addEventListener('click', () => captureFrameAndSend());

// Upload by image URL (used when server saved a captured frame and returned its public URL)
async function uploadByImageUrl(imageUrl) {
    loading.style.display = 'block';
    startTimer();
    form.querySelector('.btn-primary').disabled = true;
    const formData = new FormData();
    formData.append('image_url', imageUrl);
    formData.append('conf', confSlider.value);
    formData.append('iou', iouSlider.value);

    try {
        const res = await fetch('/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error('Server error: ' + res.status);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const processedUrl = data.processed_image_url + '?t=' + Date.now();
        if (processedImg) {
            processedImg.onload = () => processedImg.classList.add('active');
            processedImg.src = processedUrl;
            downloadBtn.href = data.processed_image_url;
        }

        // update counts + density
        let totalVehicles = 0;
        if (data.counts && Array.isArray(data.counts)) {
            for (let i = 0; i < data.counts.length; i++) {
                const countEl = document.getElementById(`count-${i}`);
                if (countEl) countEl.textContent = data.counts[i];
                totalVehicles += data.counts[i];
            }
        }
        updateDensity(totalVehicles);

        // update light times
        if (typeof data.red_seconds === 'number') {
            const r = Number(data.red_seconds);
            const y = Number(data.yellow_seconds || 3);
            const g = Number(data.green_seconds || Math.max(0, r - y));
            updateLightTimes(g, y, r);
        }

    } catch (err) {
        console.error(err);
        showError('Lỗi upload ảnh: ' + (err.message || err));
    } finally {
        loading.style.display = 'none';
        form.querySelector('.btn-primary').disabled = false;
        stopTimer();
    }
}
let startTime = null;
let timerInterval = null;

function startTimer() {
    startTime = Date.now();

    if (timerInterval) clearInterval(timerInterval);

    // chạy mỗi 0.1 giây
    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        // Chuyển elapsed giây → hh:mm:ss
        const hours = String(Math.floor(elapsed / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
        const seconds = String(elapsed % 60).padStart(2, "0");

        timeDisplay.textContent = `${hours}:${minutes}:${seconds}`;
    }, 100);
}

function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timeDisplay.textContent = "00:00:00";  // reset
}

// Khởi tạo giao diện
// 3 đèn luôn sáng (class "active" đã có trong HTML)

// ==========================================
// FILE INPUT HANDLING — xử lý khi chọn file ảnh
// Hiển thị preview tên file, kích thước, và tên file output detect
// ==========================================
imageInput.addEventListener("change", (e) => {
    const file = e.target.files[0];

    if (file) {
        // Tách tên file ra để tạo tên dạng xxx_detect.jpg
        const nameOnly = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
        const ext = file.name.substring(file.name.lastIndexOf('.'));
        const processedName = `${nameOnly}_detect${ext}`;

        // NOTE: Hiển thị tên file theo dạng: "✓ input.jpg → input_detect.jpg (512 KB)"
        fileNameDisplay.textContent = `✓ ${file.name} → ${processedName} (${(file.size / 1024).toFixed(2)} KB)`;
        fileNameDisplay.style.color = "#44dd44"; // xanh lá
    } else {
        fileNameDisplay.textContent = "Chưa chọn file";
        fileNameDisplay.style.color = "#999";
    }
});

// ==========================================
// SLIDER UPDATES — cập nhật số khi kéo slider CONF / IOU
// ==========================================
confSlider.addEventListener("input", (e) => {
    confVal.textContent = e.target.value; // NOTE: cập nhật realtime
});

iouSlider.addEventListener("input", (e) => {
    iouVal.textContent = e.target.value;
});

// ==========================================
// FORM SUBMISSION — Khi bấm nút Detect
// Gửi ảnh + conf + iou tới server bằng fetch()
// ==========================================
form.addEventListener("submit", async (e) => {
    e.preventDefault(); // chặn reload trang

    const file = imageInput.files[0];
    if (!file) {
        showError("Vui lòng chọn một file ảnh");
        return;
    }

    // Preview ảnh gốc
    // NOTE: createObjectURL tạo URL tạm cho file local
    originalImg.src = URL.createObjectURL(file);
    originalImg.classList.add("active");

    // Ẩn ảnh detect cũ
    processedImg.classList.remove("active");

    // Show loading bar
    loading.style.display = "block";
    errorMessage.style.display = "none";

    // Disable nút Detect để tránh spam
    form.querySelector(".btn-primary").disabled = true;

    // Bắt đầu đếm thời gian
    startTimer();

    // 3 đèn luôn sáng - không cần gọi setStatus()

    // FormData gửi dạng multipart/form-data
    const formData = new FormData();
    formData.append("image", file);
    formData.append("conf", confSlider.value);
    formData.append("iou", iouSlider.value);

    try {
        // Gửi request đến /upload
        const res = await fetch("/upload", {
            method: "POST",
            body: formData
        });

        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        // Nhận JSON trả về
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        // NOTE: thêm timestamp để tránh cache ảnh cũ
        const imageUrl = data.processed_image_url + '?t=' + Date.now();

        // Khi ảnh xử lý load xong thì mới hiện
        processedImg.onload = () => {
            processedImg.classList.add("active");
            downloadBtn.href = data.processed_image_url; // link download file detect

            // Cập nhật các ô đếm (counts[0..5])
            // Tính tổng số xe để hiển thị mật độ
            let totalVehicles = 0;
            if (data.counts && Array.isArray(data.counts)) {
                for (let i = 0; i < data.counts.length; i++) {
                    const countEl = document.getElementById(`count-${i}`);
                    if (countEl) countEl.textContent = data.counts[i];
                    totalVehicles += data.counts[i];
                }
            }
            
            // Cập nhật hiển thị mật độ
            updateDensity(totalVehicles);

            // Nếu server cung cấp thời gian tính toán thật → cập nhật các đèn
            if (typeof data.red_seconds === 'number') {
                const r = Number(data.red_seconds);
                const y = Number(data.yellow_seconds || 3);
                const g = Number(data.green_seconds || Math.max(0, r - y));
                updateLightTimes(g, y, r);  // Cập nhật thời gian trên 3 đèn
            }

            // Không gọi setStatus() nữa - 3 đèn luôn sáng
        };

        // Xử lý lỗi khi load ảnh detect fail
        processedImg.onerror = () => {
            showError("Không thể tải ảnh xử lý (404 hoặc server chưa ghi file).");
        };

        processedImg.src = imageUrl; // load ảnh detect

        showError("");

    } catch (err) {
        console.error("Error:", err);
        showError(`Lỗi: ${err.message}`);
        setStatus("error");
    } finally {
        loading.style.display = "none";
        form.querySelector(".btn-primary").disabled = false;
        stopTimer(); // reset timer
    }
});

// ==========================================
// ERROR DISPLAY — Hàm hiển thị lỗi UI
// ==========================================
function showError(message) {
    if (message) {
        errorMessage.textContent = message;
        errorMessage.style.display = "block";
    } else {
        errorMessage.style.display = "none";
    }
}
