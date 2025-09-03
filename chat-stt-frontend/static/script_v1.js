/**
 * AI聊天助手 - 增强版
 * 支持实时语音对话、TTS播放控制、语音打断等功能
 */

/**
 * 同步读取YAML文件并加载到Map中
 */
function loadYamlToMapSync(yamlFilePath = 'config/total_config.yml') {
    const configMap = new Map();
    const xhr = new XMLHttpRequest();
    
    try {
        xhr.open('GET', yamlFilePath, false);
        xhr.send(null);
        
        if (xhr.status !== 200) {
            throw new Error(`无法加载YAML文件: ${xhr.status} ${xhr.statusText}`);
        }
        
        const yamlContent = xhr.responseText;
        const lines = yamlContent.split('\n');
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;
            
            const colonIndex = trimmedLine.indexOf(':');
            if (colonIndex === -1) continue;
            
            const key = trimmedLine.substring(0, colonIndex).trim();
            const value = trimmedLine.substring(colonIndex + 1).trim();
            configMap.set(key, value);
        }
        
        console.log(`成功加载YAML配置，共${configMap.size}项`);
        return configMap;
        
    } catch (error) {
        console.error('加载YAML文件失败:', error);
        return configMap;
    }
}

// API基础URL和TTS配置
let API_BASE;
let TTS_API_BASE;
let TTS_API_TOKEN;

// 同步初始化配置
function initConfigSync() {
    const configMap = loadYamlToMapSync();
    API_BASE = configMap.get('API_BASE');
    TTS_API_BASE = configMap.get('TTS_API_BASE') || 'https://api.siliconflow.cn/v1/audio/speech';
    TTS_API_TOKEN = configMap.get('TTS_API_TOKEN') || '';
}

initConfigSync();

// 全局变量
let conversationId = '';
let isLoading = false;
let messageCount = 1;

// 语音录制变量
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let silenceTimer = null;
let audioContext = null;
let analyser = null;
let silenceThreshold = 30;
let silenceTimeout = 2000;

// 实时语音对话变量
let isVoiceModeActive = false;
let continuousRecorder = null;
let continuousStream = null;
let isProcessingRealtime = false;
let realtimeAudioChunks = [];
let voiceActivityDetected = false;
let voiceStartTime = null;
let minimumSpeechDuration = 1000; // 最小语音时长1秒
let maxSpeechDuration = 30000; // 最大语音时长30秒

// TTS和音频播放变量
let isTTSEnabled = true;
let audioPlayer = null;
let isPlayingAudio = false;
let currentPlayingMessage = null;

// 语音可视化变量
let visualizerAnimationFrame = null;
let waveBars = [];

// 图表计数器
let chartIdCounter = 0;

// 配置marked.js
marked.setOptions({
    highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
            try {
                return hljs.highlight(code, { language: lang }).value;
            } catch (err) {
                console.warn('代码高亮失败:', err);
            }
        }
        return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true,
    tables: true,
    sanitize: false
});

// 自定义渲染器
const renderer = new marked.Renderer();

renderer.listitem = function(text) {
    if (/^\[[x ]\]\s/.test(text)) {
        const checked = text.indexOf('[x]') === 0;
        text = text.replace(/^\[[x ]\]\s/, '');
        return `<li class="task-list-item"><input type="checkbox" ${checked ? 'checked' : ''} disabled> ${text}</li>`;
    }
    return `<li>${text}</li>`;
};

renderer.code = function(code, language) {
    const validLang = language && hljs.getLanguage(language) ? language : 'plaintext';
    const highlighted = hljs.highlight(code, { language: validLang }).value;
    
    return `
        <div class="code-block-wrapper">
            <pre><code class="hljs ${validLang}">${highlighted}</code></pre>
            <button class="copy-code-btn" onclick="copyCode(this)" title="复制代码">复制</button>
        </div>
    `;
};

marked.use({ renderer });

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
    initializeChat();
});

// 初始化聊天界面
function initializeChat() {
    const input = document.getElementById('messageInput');
    
    if (!input) {
        console.error('找不到消息输入框元素');
        return;
    }
    
    // 输入框事件处理
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
            e.preventDefault();
            sendMessage();
        } else if (e.key === 'Enter' && e.shiftKey) {
            setTimeout(() => autoResizeTextarea(input), 0);
        }
    });

    input.addEventListener('input', () => autoResizeTextarea(input));
    
    // 🎧 初始化HTML5音频播放器 - 这是播放TTS音频的核心元素
    audioPlayer = document.getElementById('audioPlayer');
    if (audioPlayer) {
        // 🔚 监听播放结束事件
        audioPlayer.addEventListener('ended', onAudioPlayEnded);
        // ❌ 监听播放错误事件  
        audioPlayer.addEventListener('error', onAudioPlayError);
    }
    
    // 🎛️ 初始化TTS语音播放开关控制
    const ttsToggle = document.getElementById('ttsEnabled');
    if (ttsToggle) {
        isTTSEnabled = ttsToggle.checked;                           // 📖 读取初始开关状态
        ttsToggle.addEventListener('change', function() {
            isTTSEnabled = this.checked;                            // 🔄 更新全局TTS开关状态
            updateStatus(isTTSEnabled ? '语音播放已开启' : '语音播放已关闭');
            setTimeout(() => updateStatus(''), 2000);
        });
    }
    
    // 初始化语音可视化
    initVoiceVisualizer();
    
    // 设置初始时间戳
    const timestampElement = document.querySelector('.timestamp');
    if (timestampElement) {
        timestampElement.textContent = formatTime(new Date());
    }
    
    // 检查语音支持
    checkAudioSupport();
}

// 初始化语音可视化
function initVoiceVisualizer() {
    const visualizer = document.getElementById('voiceVisualizer');
    if (visualizer) {
        waveBars = visualizer.querySelectorAll('.wave-bar');
    }
}

// 自动调整文本框高度
function autoResizeTextarea(textarea) {
    if (!textarea) return;
    
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 120);
    textarea.style.height = newHeight + 'px';
}

// 检查音频支持
async function checkAudioSupport() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('浏览器不支持音频录制');
        }
        
        if (!window.MediaRecorder) {
            throw new Error('浏览器不支持MediaRecorder API');
        }
        
        updateStatus('语音功能已就绪');
        setTimeout(() => updateStatus(''), 2000);
    } catch (error) {
        console.error('音频支持检查失败:', error);
        updateStatus('⚠️ 语音功能不可用: ' + error.message);
        
        const voiceButton = document.getElementById('voiceButton');
        const voiceModeButton = document.getElementById('voiceModeButton');
        
        if (voiceButton) voiceButton.style.visibility = 'hidden';
        if (voiceModeButton) voiceModeButton.style.visibility = 'hidden';
    }
}

// ===================== 实时语音对话功能 =====================

// 切换实时语音对话模式
async function toggleVoiceMode() {
    if (isLoading) {
        updateStatus('请等待当前操作完成');
        return;
    }

    if (isVoiceModeActive) {
        await stopVoiceMode();
    } else {
        await startVoiceMode();
    }
}

// 开启实时语音对话模式
async function startVoiceMode() {
    try {
        updateStatus('正在启动实时语音对话模式...');
        
        // 🛑🎵 启动实时模式时停止当前播放的音频
        if (isPlayingAudio && audioPlayer) {
            audioPlayer.pause();                  // ⏸️ 暂停播放
            audioPlayer.currentTime = 0;          // ⏮️ 重置到开头
            isPlayingAudio = false;               // 🔄 重置状态
        }
        
        // 获取音频流
        continuousStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        // 设置音频分析器用于语音活动检测
        if (audioContext && audioContext.state !== 'closed') {
            await audioContext.close();
        }
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(continuousStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);
        
        // 创建连续录制器
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/wav'
        ];
        
        let selectedMimeType = 'audio/webm';
        for (const mimeType of mimeTypes) {
            if (MediaRecorder.isTypeSupported(mimeType)) {
                selectedMimeType = mimeType;
                break;
            }
        }
        
        continuousRecorder = new MediaRecorder(continuousStream, {
            mimeType: selectedMimeType
        });
        
        realtimeAudioChunks = [];
        
        continuousRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                realtimeAudioChunks.push(event.data);
            }
        };
        
        continuousRecorder.onstop = () => {
            if (realtimeAudioChunks.length > 0 && !isProcessingRealtime) {
                processRealtimeAudio();
            }
        };
        
        // 开始录制
        continuousRecorder.start();
        isVoiceModeActive = true;
        
        // 开始语音活动检测
        startVoiceActivityDetection();
        
        // 更新UI
        updateVoiceModeUI(true);
        updateStatus('🎙️ 实时语音对话模式已激活，可以随时说话');
        
        // 显示语音可视化
        showVoiceVisualizer(true);
        
    } catch (error) {
        console.error('启动实时语音对话失败:', error);
        updateStatus('❌ 启动实时语音对话失败: ' + error.message);
        await stopVoiceMode();
    }
}

// 停止实时语音对话模式
async function stopVoiceMode() {
    try {
        isVoiceModeActive = false;
        
        // 停止录制器
        if (continuousRecorder && continuousRecorder.state !== 'inactive') {
            continuousRecorder.stop();
        }
        
        // 停止音频流
        if (continuousStream) {
            continuousStream.getTracks().forEach(track => track.stop());
            continuousStream = null;
        }
        
        // 关闭音频上下文
        if (audioContext && audioContext.state !== 'closed') {
            await audioContext.close();
        }
        
        // 停止语音活动检测
        if (visualizerAnimationFrame) {
            cancelAnimationFrame(visualizerAnimationFrame);
            visualizerAnimationFrame = null;
        }
        
        // 更新UI
        updateVoiceModeUI(false);
        showVoiceVisualizer(false);
        updateStatus('实时语音对话模式已关闭');
        setTimeout(() => updateStatus(''), 2000);
        
        // 清理变量
        continuousRecorder = null;
        voiceActivityDetected = false;
        voiceStartTime = null;
        realtimeAudioChunks = [];
        
    } catch (error) {
        console.error('停止实时语音对话失败:', error);
    }
}

// 语音活动检测
function startVoiceActivityDetection() {
    if (!isVoiceModeActive || !analyser) return;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const energyThreshold = 40; // 调整这个值来控制敏感度
    const silenceDuration = 1500; // 静音持续时间1.5秒后处理
    
    function detectVoiceActivity() {
        if (!isVoiceModeActive || !analyser) return;
        
        analyser.getByteFrequencyData(dataArray);
        
        // 计算音频能量
        const sum = dataArray.reduce((a, b) => a + b, 0);
        const average = sum / bufferLength;
        
        // 更新可视化
        updateVoiceVisualizer(average);
        
        const now = Date.now();
        
        if (average > energyThreshold) {
            // 检测到语音活动
            if (!voiceActivityDetected) {
                voiceActivityDetected = true;
                voiceStartTime = now;
                console.log('语音活动开始');
                
                // 重新开始录制以捕获完整的语音
                if (continuousRecorder && continuousRecorder.state === 'recording') {
                    continuousRecorder.stop();
                    
                    setTimeout(() => {
                        if (isVoiceModeActive && continuousStream) {
                            realtimeAudioChunks = [];
                            continuousRecorder = new MediaRecorder(continuousStream, {
                                mimeType: continuousRecorder.mimeType
                            });
                            continuousRecorder.ondataavailable = (event) => {
                                if (event.data && event.data.size > 0) {
                                    realtimeAudioChunks.push(event.data);
                                }
                            };
                            continuousRecorder.onstop = () => {
                                if (realtimeAudioChunks.length > 0 && !isProcessingRealtime) {
                                    processRealtimeAudio();
                                }
                            };
                            continuousRecorder.start();
                        }
                    }, 100);
                }
            }
            
            // 清除静音定时器
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
            
        } else if (voiceActivityDetected) {
            // 在语音活动后检测到静音
            if (!silenceTimer) {
                silenceTimer = setTimeout(() => {
                    if (voiceActivityDetected && isVoiceModeActive) {
                        const speechDuration = now - voiceStartTime;
                        
                        if (speechDuration >= minimumSpeechDuration) {
                            console.log(`语音活动结束，持续时间: ${speechDuration}ms`);
                            
                            // 停止当前录制并处理音频
                            if (continuousRecorder && continuousRecorder.state === 'recording') {
                                continuousRecorder.stop();
                            }
                            
                            voiceActivityDetected = false;
                            voiceStartTime = null;
                        } else {
                            console.log('语音持续时间太短，忽略');
                            voiceActivityDetected = false;
                            voiceStartTime = null;
                        }
                    }
                    silenceTimer = null;
                }, silenceDuration);
            }
        }
        
        // 防止语音过长
        if (voiceActivityDetected && voiceStartTime && (now - voiceStartTime) > maxSpeechDuration) {
            console.log('语音时长超过限制，强制处理');
            if (continuousRecorder && continuousRecorder.state === 'recording') {
                continuousRecorder.stop();
            }
            voiceActivityDetected = false;
            voiceStartTime = null;
        }
        
        if (isVoiceModeActive) {
            visualizerAnimationFrame = requestAnimationFrame(detectVoiceActivity);
        }
    }
    
    detectVoiceActivity();
}

// 处理实时语音音频
async function processRealtimeAudio() {
    if (isProcessingRealtime || realtimeAudioChunks.length === 0) {
        return;
    }
    
    isProcessingRealtime = true;
    
    try {
        updateStatus('正在处理语音...');
        
        // 🛑🎵 语音打断功能 - 用户说话时立即停止AI的语音播放！
        if (isPlayingAudio && audioPlayer) {
            audioPlayer.pause();                  // ⏸️ 暂停当前播放
            audioPlayer.currentTime = 0;          // ⏮️ 重置播放位置到开头
            isPlayingAudio = false;               // 🔄 重置播放状态标志
            console.log('🎤➡️🔇 TTS播放被语音输入打断');
        }
        
        const audioBlob = new Blob(realtimeAudioChunks, { type: 'audio/webm' });
        
        if (audioBlob.size === 0) {
            console.log('音频文件为空，跳过处理');
            return;
        }
        
        if (audioBlob.size > 25 * 1024 * 1024) {
            updateStatus('语音过长，请说话简短一些');
            return;
        }
        
        const formData = new FormData();
        formData.append('audio', audioBlob, 'realtime.webm');
        formData.append('language', 'auto');
        
        // 发送到语音转文字接口
        const response = await fetch(`${API_BASE}/transcribe`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(30000)
        });
        
        if (!response.ok) {
            throw new Error(`语音转文字失败 (${response.status})`);
        }
        
        const data = await response.json();
        
        if (data.success && data.text && data.text.trim()) {
            const transcribedText = data.text.trim();
            console.log('实时语音识别结果:', transcribedText);
            
            // 添加用户消息并自动发送
            addMessage(transcribedText, true);
            messageCount++;
            updateMessageCount();
            
            // 自动发送到AI
            await sendMessageToAI(transcribedText);
            
        } else {
            console.log('未识别到有效语音内容');
        }
        
    } catch (error) {
        console.error('处理实时语音失败:', error);
        if (error.name !== 'AbortError') {
            updateStatus('语音处理失败: ' + error.message);
        }
    } finally {
        isProcessingRealtime = false;
        realtimeAudioChunks = [];
        
        // 重新启动录制器以继续监听
        if (isVoiceModeActive && continuousStream && !isLoading) {
            setTimeout(async () => {
                try {
                    if (isVoiceModeActive && continuousStream) {
                        continuousRecorder = new MediaRecorder(continuousStream, {
                            mimeType: continuousRecorder.mimeType
                        });
                        
                        continuousRecorder.ondataavailable = (event) => {
                            if (event.data && event.data.size > 0) {
                                realtimeAudioChunks.push(event.data);
                            }
                        };
                        
                        continuousRecorder.onstop = () => {
                            if (realtimeAudioChunks.length > 0 && !isProcessingRealtime) {
                                processRealtimeAudio();
                            }
                        };
                        
                        continuousRecorder.start();
                        updateStatus('🎙️ 继续监听语音输入...');
                    }
                } catch (error) {
                    console.error('重新启动录制器失败:', error);
                }
            }, 500);
        }
    }
}

// ===================== 普通语音录制功能 =====================

// 普通语音录制
async function startRecording() {
    // 如果实时语音模式开启，先关闭
    if (isVoiceModeActive) {
        await stopVoiceMode();
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    try {
        if (audioContext && audioContext.state === 'running') {
            await audioContext.close();
        }
        
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            } 
        });
        
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/wav'
        ];
        
        let selectedMimeType = 'audio/webm';
        for (const mimeType of mimeTypes) {
            if (MediaRecorder.isTypeSupported(mimeType)) {
                selectedMimeType = mimeType;
                break;
            }
        }
        
        mediaRecorder = new MediaRecorder(stream, {
            mimeType: selectedMimeType
        });
        
        audioChunks = [];
        
        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        
        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(track => track.stop());
            processAudio();
        };
        
        mediaRecorder.onerror = (event) => {
            console.error('MediaRecorder错误:', event.error);
            stopRecording();
            updateStatus('❌ 录音过程中发生错误');
        };
        
        // 音频分析器
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(stream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
        } catch (audioError) {
            console.warn('音频分析器初始化失败:', audioError);
        }
        
        mediaRecorder.start(100);
        isRecording = true;
        
        updateRecordingUI(true);
        if (analyser) {
            startSilenceDetection();
        }
        
        updateStatus('正在录音...');
        
    } catch (error) {
        console.error('开始录音失败:', error);
        updateStatus('❌ 录音失败: ' + error.message);
        updateRecordingUI(false);
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        try {
            mediaRecorder.stop();
        } catch (error) {
            console.error('停止录音失败:', error);
        }
        
        isRecording = false;
        
        if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
        }
        
        updateRecordingUI(false, true);
    }
}

function toggleRecording() {
    if (isLoading || isVoiceModeActive) {
        updateStatus(isVoiceModeActive ? '实时对话模式下无需手动录音' : '请等待当前操作完成');
        return;
    }
    
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

// 静音检测（普通录音）
function startSilenceDetection() {
    if (!analyser || !isRecording) return;
    
    try {
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        function checkAudioLevel() {
            if (!isRecording || !analyser) return;
            
            try {
                analyser.getByteFrequencyData(dataArray);
                const sum = dataArray.reduce((a, b) => a + b, 0);
                const average = sum / bufferLength;
                
                if (average > silenceThreshold) {
                    if (silenceTimer) {
                        clearTimeout(silenceTimer);
                    }
                    silenceTimer = setTimeout(() => {
                        if (isRecording) {
                            stopRecording();
                        }
                    }, silenceTimeout);
                }
                
                if (isRecording) {
                    requestAnimationFrame(checkAudioLevel);
                }
            } catch (error) {
                console.warn('音频级别检测失败:', error);
            }
        }
        
        checkAudioLevel();
    } catch (error) {
        console.error('静音检测初始化失败:', error);
    }
}

// 处理普通录音音频
async function processAudio() {
    if (audioChunks.length === 0) {
        updateRecordingUI(false);
        updateStatus('录音时间太短或无音频数据');
        return;
    }

    const maxRetries = 3;
    let retryCount = 0;

    async function attemptTranscription() {
        try {
            updateRecordingUI(false, true);
            updateStatus(`正在转换语音...${retryCount > 0 ? ` (重试 ${retryCount}/${maxRetries})` : ''}`);

            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            
            if (audioBlob.size === 0) {
                throw new Error('音频文件为空');
            }
            
            if (audioBlob.size > 25 * 1024 * 1024) {
                throw new Error('音频文件过大，请录制较短的语音');
            }
            
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');
            formData.append('language', 'auto');

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            const response = await fetch(`${API_BASE}/transcribe`, {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`语音转文字服务错误 (${response.status}): ${errorData}`);
            }

            const data = await response.json();
            
            if (data.success && data.text && data.text.trim()) {
                const input = document.getElementById('messageInput');
                if (input) {
                    input.value = data.text.trim();
                    autoResizeTextarea(input);
                    updateStatus('语音转换完成');
                    
                    setTimeout(() => {
                        sendMessage();
                    }, 500);
                } else {
                    throw new Error('找不到输入框元素');
                }
            } else if (!data.success) {
                throw new Error(data.error || '语音识别失败');
            } else {
                throw new Error('未检测到有效语音内容');
            }

        } catch (error) {
            console.error('处理音频失败:', error);
            
            if (error.name === 'AbortError') {
                throw new Error('语音处理超时，请重试');
            }
            
            if (retryCount < maxRetries && (
                error.message.includes('Failed to fetch') || 
                error.message.includes('Network') ||
                error.message.includes('timeout')
            )) {
                retryCount++;
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                return attemptTranscription();
            }
            
            throw error;
        }
    }

    try {
        await attemptTranscription();
    } catch (error) {
        updateStatus('❌ 语音处理失败: ' + error.message);
    } finally {
        updateRecordingUI(false);
        audioChunks = [];
    }
}

// ===================== UI更新函数 =====================

// 更新实时语音模式UI
function updateVoiceModeUI(active) {
    const voiceModeButton = document.getElementById('voiceModeButton');
    const voiceModeIcon = document.getElementById('voiceModeIcon');
    const voiceStatus = document.getElementById('voiceStatus');
    const realtimeIndicator = document.getElementById('realtimeIndicator');
    const inputHints = document.querySelectorAll('.voice-hint, .realtime-hint');
    
    if (voiceModeButton) {
        voiceModeButton.className = active ? 'voice-mode-button active' : 'voice-mode-button';
    }
    
    if (voiceModeIcon) {
        voiceModeIcon.textContent = active ? '🔴' : '🎙️';
    }
    
    if (voiceStatus) {
        voiceStatus.textContent = active ? '语音模式: 实时对话' : '语音模式: 关闭';
    }
    
    if (realtimeIndicator) {
        realtimeIndicator.style.display = active ? 'flex' : 'none';
    }
    
    // 更新提示信息
    inputHints.forEach(hint => {
        if (hint.classList.contains('voice-hint')) {
            hint.style.display = active ? 'none' : 'block';
        } else if (hint.classList.contains('realtime-hint')) {
            hint.style.display = active ? 'block' : 'none';
        }
    });
}

// 显示/隐藏语音可视化
function showVoiceVisualizer(show) {
    const visualizer = document.getElementById('voiceVisualizer');
    if (visualizer) {
        visualizer.style.display = show ? 'flex' : 'none';
    }
}

// 更新语音可视化
function updateVoiceVisualizer(audioLevel) {
    if (!waveBars || waveBars.length === 0) return;
    
    const normalizedLevel = Math.min(audioLevel / 100, 1);
    const barCount = waveBars.length;
    
    waveBars.forEach((bar, index) => {
        const height = Math.random() * normalizedLevel * 40 + 5;
        const delay = index * 0.1;
        bar.style.height = height + 'px';
        bar.style.animationDelay = delay + 's';
        bar.style.backgroundColor = normalizedLevel > 0.3 ? '#4CAF50' : '#ddd';
    });
}

// 更新录音UI状态
function updateRecordingUI(recording, processing = false) {
    const voiceButton = document.getElementById('voiceButton');
    const voiceIcon = document.getElementById('voiceIcon');
    const voiceHint = document.getElementById('voiceHint');
    
    if (!voiceButton) {
        console.warn('语音按钮元素不存在');
        return;
    }
    
    if (recording) {
        voiceButton.className = 'voice-button recording';
        if (voiceIcon) {
            voiceIcon.innerHTML = `
                <div class="audio-wave">
                    <span></span>
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            `;
        }
        if (voiceHint && !isVoiceModeActive) {
            voiceHint.classList.add('show');
            voiceHint.textContent = '正在录音，2秒静音后自动发送...';
        }
    } else if (processing) {
        voiceButton.className = 'voice-button processing';
        if (voiceIcon) {
            voiceIcon.innerHTML = '<div class="loading-spinner"></div>';
        }
        if (voiceHint && !isVoiceModeActive) {
            voiceHint.classList.add('show');
            voiceHint.textContent = '正在处理语音...';
        }
    } else {
        voiceButton.className = 'voice-button idle';
        if (voiceIcon) {
            voiceIcon.textContent = '🎤';
        }
        if (voiceHint) {
            voiceHint.classList.remove('show');
        }
    }
}

// ===================== 发送消息功能 =====================

// 发送消息
async function sendMessage() {
    const input = document.getElementById('messageInput');
    
    if (!input) {
        console.error('找不到输入框元素');
        return;
    }
    
    const message = input.value.trim();
    
    if (!message || isLoading) return;
    
    // 禁用输入控件
    setInputsEnabled(false);
    isLoading = true;
    updateStatus('发送中...');
    
    // 添加用户消息
    addMessage(message, true);
    input.value = '';
    autoResizeTextarea(input);
    messageCount++;
    updateMessageCount();
    
    await sendMessageToAI(message);
}

// 发送消息到AI
async function sendMessageToAI(message) {
    // 显示AI思考状态
    showTypingIndicator();
    
    let retryCount = 0;
    const maxRetries = 2;
    
    async function attemptSendMessage() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000);
            
            const response = await fetch(`${API_BASE}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: message,
                    conversation_id: conversationId
                }),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`服务器响应错误 (${response.status}): ${errorText}`);
            }
            
            // 处理流式响应
            await handleStreamResponse(response);
            
        } catch (error) {
            console.error('发送消息失败:', error);
            
            if (retryCount < maxRetries && (
                error.name === 'AbortError' ||
                error.message.includes('Failed to fetch') ||
                error.message.includes('Network') ||
                error.message.includes('timeout')
            )) {
                retryCount++;
                updateStatus(`连接失败，正在重试... (${retryCount}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
                return attemptSendMessage();
            }
            
            hideTypingIndicator();
            addMessage(`❌ 发送失败: ${error.message}`, false);
            updateStatus('消息发送失败');
        }
    }
    
    try {
        await attemptSendMessage();
    } finally {
        setInputsEnabled(true);
        isLoading = false;
        const input = document.getElementById('messageInput');
        if (input && !isVoiceModeActive) {
            input.focus();
        }
    }
}

// 处理流式响应
async function handleStreamResponse(response) {
    let assistantMessage = null;
    let completeAnswer = '';
    
    try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const jsonData = line.slice(6).trim();
                        if (!jsonData || jsonData === '[DONE]') continue;
                        
                        const data = JSON.parse(jsonData);
                        
                        if (data.event === 'workflow_started') {
                            hideTypingIndicator();
                            conversationId = data.conversation_id || '';
                            const conversationIdElement = document.getElementById('conversationId');
                            if (conversationIdElement) {
                                conversationIdElement.textContent = 
                                    conversationId ? conversationId.slice(0, 8) + '...' : '等待开始';
                            }
                            updateStatus('AI正在思考...');
                        }
                        else if (data.event === 'message') {
                            if (!assistantMessage) {
                                assistantMessage = addMessage('', false, false, true);
                            }
                            
                            completeAnswer = data.complete_answer || data.answer || '';
                            updateMessageContent(assistantMessage, completeAnswer);
                        }
                        else if (data.event === 'workflow_finished') {
                            if (assistantMessage) {
                                const finalAnswer = data.final_answer || completeAnswer;
                                updateMessageContent(assistantMessage, finalAnswer, true);
                                messageCount++;
                                updateMessageCount();
                                
                                // 自动播放TTS (如果开启)
                                if (isTTSEnabled && finalAnswer.trim()) {
                                    await playTTS(finalAnswer, assistantMessage);
                                }
                            }
                            updateStatus('回答完成');
                            setTimeout(() => updateStatus(''), 2000);
                        }
                        else if (data.event === 'error') {
                            hideTypingIndicator();
                            addMessage(`❌ AI服务错误: ${data.error || '未知错误'}`, false);
                            updateStatus('AI服务发生错误');
                            break;
                        }
                        
                    } catch (parseError) {
                        console.warn('解析响应数据失败:', parseError, '原始数据:', line);
                    }
                }
            }
        }
    } catch (error) {
        console.error('处理流式响应失败:', error);
        hideTypingIndicator();
        
        if (!assistantMessage) {
            addMessage(`❌ 响应处理失败: ${error.message}`, false);
        }
        
        throw error;
    }
}

// ========================================================================================
// 🔊🔊🔊 TTS音频播放核心功能区域 - 这里是所有音频播放的关键代码！🔊🔊🔊
// ========================================================================================

// 🎵 主要TTS播放函数 - 将文字转换为语音并播放
async function playTTS(text, messageElement) {
    // 🚫 检查播放条件：TTS开关、文本内容、API令牌
    if (!isTTSEnabled || !text.trim() || !TTS_API_TOKEN) {
        return;
    }
    
    try {
        // 🛑 如果正在播放其他音频，先停止当前播放
        if (isPlayingAudio && audioPlayer) {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
        }
        
        updateStatus('正在生成语音...');
        
        console.log(TTS_API_TOKEN)

        // 🌐 调用TTS API生成语音
        const response = await fetch(TTS_API_BASE, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${TTS_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'fnlp/MOSS-TTSD-v0.5',      // 🤖 使用SiliconFlow支持的TTS模型  
                input: text,                         // 📝 要转换的文字
                voice: 'fnlp/MOSS-TTSD-v0.5:anna', // 🎤 系统预定义语音
                response_format: 'mp3'               // 🎧 音频格式
            })
        });
        
        if (!response.ok) {
            const errorData = await response.text();
            console.error('TTS API错误响应:', errorData);
            throw new Error(`TTS服务错误 (${response.status}): ${errorData}`);
        }
        
        // 🎧 获取音频文件并创建播放URL
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        
        // 🎯 设置HTML音频播放器并开始播放
        if (audioPlayer) {
            audioPlayer.src = audioUrl;                    // 📍 设置音频源
            currentPlayingMessage = messageElement;         // 🎯 记录当前播放的消息
            isPlayingAudio = true;                         // 🔄 更新播放状态
            
            // 🎨 更新消息上的播放按钮显示状态
            updateMessageAudioButton(messageElement, 'playing');
            
            // 🎵 开始播放音频！
            audioPlayer.play();
            updateStatus('🔊 正在播放语音');
        }
        
    } catch (error) {
        console.error('TTS播放失败:', error);
        updateStatus('语音播放失败');
        setTimeout(() => updateStatus(''), 2000);
    }
}

// 🎮 手动播放消息音频 - 点击消息旁的播放按钮时调用
async function playMessageAudio(button) {
    const messageElement = button.closest('.message');
    if (!messageElement || !isTTSEnabled) return;
    
    const messageContent = messageElement.querySelector('.message-content');
    if (!messageContent) return;
    
    // 📝 提取纯文本内容（去除时间戳）
    const textContent = messageContent.textContent.replace(/\d{2}:\d{2}:\d{2}$/, '').trim();
    
    if (textContent) {
        // 🎵 调用主播放函数
        await playTTS(textContent, messageElement);
    }
}

// 🔚 音频播放结束事件处理 - 当音频播放完毕时自动触发
function onAudioPlayEnded() {
    isPlayingAudio = false;                                         // 🔄 重置播放状态
    if (currentPlayingMessage) {
        updateMessageAudioButton(currentPlayingMessage, 'idle');    // 🎨 恢复按钮状态
        currentPlayingMessage = null;                               // 🧹 清除当前播放记录
    }
    updateStatus('');                                               // 🧹 清除状态提示
    
    // 🗑️ 清理音频URL资源，释放内存
    if (audioPlayer && audioPlayer.src.startsWith('blob:')) {
        URL.revokeObjectURL(audioPlayer.src);
    }
}

// ❌ 音频播放错误事件处理 - 当音频播放出现问题时触发
function onAudioPlayError() {
    isPlayingAudio = false;                                         // 🔄 重置播放状态
    if (currentPlayingMessage) {
        updateMessageAudioButton(currentPlayingMessage, 'error');   // 🎨 显示错误状态
        currentPlayingMessage = null;                               // 🧹 清除当前播放记录
    }
    updateStatus('语音播放出错');                                    // ⚠️ 显示错误提示
    setTimeout(() => updateStatus(''), 2000);                      // ⏰ 2秒后清除提示
}

// 更新消息音频按钮状态
function updateMessageAudioButton(messageElement, state) {
    const button = messageElement.querySelector('.play-audio-btn');
    if (!button) return;
    
    switch (state) {
        case 'playing':
            button.textContent = '⏸️';
            button.title = '暂停播放';
            break;
        case 'idle':
            button.textContent = '🔊';
            button.title = '播放语音';
            break;
        case 'error':
            button.textContent = '❌';
            button.title = '播放失败';
            setTimeout(() => {
                button.textContent = '🔊';
                button.title = '播放语音';
            }, 2000);
            break;
    }
}

// ===================== 消息处理函数 =====================

// 更新消息内容
function updateMessageContent(messageElement, content, isComplete = false) {
    if (!messageElement) {
        console.error('消息元素不存在');
        return;
    }
    
    const contentDiv = messageElement.querySelector('.message-content');
    if (!contentDiv) {
        console.error('找不到消息内容容器');
        return;
    }
    
    try {
        const isMarkdown = hasMarkdownSyntax(content);
        const renderedContent = isMarkdown ? renderMarkdown(content) : 
            content.replace(/\n/g, '<br>').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        if (isComplete) {
            contentDiv.innerHTML = `
                ${renderedContent}
                <div class="timestamp">${formatTime(new Date())}</div>
            `;
            
            // 添加音频播放按钮
            const messageControls = messageElement.querySelector('.message-controls');
            if (!messageControls) {
                const controls = document.createElement('div');
                controls.className = 'message-controls';
                controls.innerHTML = '<button class="play-audio-btn" onclick="playMessageAudio(this)" title="播放语音">🔊</button>';
                messageElement.appendChild(controls);
            }
        } else {
            contentDiv.innerHTML = renderedContent;
        }
    } catch (error) {
        console.error('更新消息内容失败:', error);
        contentDiv.textContent = content;
    }
    
    // 自动滚动
    const messagesContainer = document.getElementById('chatMessages');
    if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
}

// 辅助函数：判断内容是否包含Markdown语法
function hasMarkdownSyntax(content) {
    const markdownPatterns = [
        /^#{1,6}\s/m,        // 标题
        /^>\s/m,             // 引用
        /^[*-]\s/m,          // 列表
        /`[^`]+`/,           // 代码
        /\*\*[^*]+\*\*/,     // 粗体
        /\*[^*]+\*/,         // 斜体
        /!\[.*?\]\(.*?\)/    // 图片
    ];
    
    return markdownPatterns.some(pattern => pattern.test(content));
}

// 辅助函数：渲染Markdown内容
function renderMarkdown(content) {
    try {
        return marked.parse(content);
    } catch (error) {
        console.error('Markdown渲染失败:', error);
        return content.replace(/\n/g, '<br>');
    }
}

// 复制代码功能
function copyCode(button) {
    const codeBlock = button.nextElementSibling?.querySelector('code') || 
                      button.previousElementSibling?.querySelector('code');
    
    if (codeBlock) {
        const code = codeBlock.textContent;
        navigator.clipboard.writeText(code).then(() => {
            const originalText = button.textContent;
            button.textContent = '已复制';
            button.style.backgroundColor = '#4CAF50';
            button.style.color = 'white';
            
            setTimeout(() => {
                button.textContent = originalText;
                button.style.backgroundColor = '';
                button.style.color = '';
            }, 2000);
        }).catch(err => {
            console.error('复制失败:', err);
            button.textContent = '复制失败';
            button.style.backgroundColor = '#f44336';
            button.style.color = 'white';
            
            setTimeout(() => {
                button.textContent = '复制';
                button.style.backgroundColor = '';
                button.style.color = '';
            }, 2000);
        });
    }
}

// 添加消息到界面
function addMessage(content, isUser, showTimestamp = true, isStreaming = false) {
    const messagesContainer = document.getElementById('chatMessages');
    if (!messagesContainer) {
        console.error('找不到消息容器');
        return null;
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isUser ? 'user' : 'assistant'}`;
    
    const timestamp = showTimestamp ? `<div class="timestamp">${formatTime(new Date())}</div>` : '';
    const renderedContent = hasMarkdownSyntax(content) ? renderMarkdown(content) : content.replace(/\n/g, '<br>');
    
    messageDiv.innerHTML = `
        <div class="message-content">
            ${renderedContent}
            ${timestamp}
        </div>
    `;
    
    // 为助手消息添加音频播放控制
    if (!isUser && !isStreaming) {
        const controls = document.createElement('div');
        controls.className = 'message-controls';
        controls.innerHTML = '<button class="play-audio-btn" onclick="playMessageAudio(this)" title="播放语音">🔊</button>';
        messageDiv.appendChild(controls);
    }
    
    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    return messageDiv;
}

// 显示AI正在输入的指示器
function showTypingIndicator() {
    const messagesContainer = document.getElementById('chatMessages');
    if (!messagesContainer) return;
    
    hideTypingIndicator();
    
    const indicator = document.createElement('div');
    indicator.className = 'message assistant typing-indicator';
    indicator.id = 'typingIndicator';
    indicator.innerHTML = `
        <div class="typing-dots">
            <span></span>
            <span></span>
            <span></span>
        </div>
        <div class="typing-text">AI正在思考...</div>
    `;
    
    messagesContainer.appendChild(indicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// 隐藏输入指示器
function hideTypingIndicator() {
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
        indicator.remove();
    }
}

// ===================== 工具函数 =====================

// 格式化时间
function formatTime(date) {
    return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// 启用/禁用输入控件
function setInputsEnabled(enabled) {
    const input = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const voiceButton = document.getElementById('voiceButton');
    const voiceModeButton = document.getElementById('voiceModeButton');
    
    if (input) {
        input.disabled = !enabled;
    }
    
    if (sendButton) {
        sendButton.disabled = !enabled;
        sendButton.innerHTML = enabled ? '➤' : '<div class="loading-spinner"></div>';
    }
    
    if (voiceButton && !isVoiceModeActive) {
        voiceButton.disabled = !enabled;
    }
    
    if (voiceModeButton) {
        voiceModeButton.disabled = !enabled;
    }
}

// 更新消息计数
function updateMessageCount() {
    const messageCountElement = document.getElementById('messageCount');
    if (messageCountElement) {
        messageCountElement.textContent = `消息数: ${messageCount}`;
    }
}

// 更新状态信息
function updateStatus(text) {
    const statusElement = document.getElementById('status');
    if (statusElement) {
        statusElement.textContent = text;
    }
}

// 清空对话
async function clearConversation() {
    if (!confirm('确定要清空所有对话记录吗？此操作不可撤销。')) {
        return;
    }
    
    try {
        // 停止实时语音模式
        if (isVoiceModeActive) {
            await stopVoiceMode();
        }
        
        // 停止普通录音
        if (isRecording) {
            stopRecording();
        }
        
        // 停止音频播放
        if (isPlayingAudio && audioPlayer) {
            audioPlayer.pause();
            audioPlayer.currentTime = 0;
            isPlayingAudio = false;
        }
        
        // 清理音频资源
        if (audioContext && audioContext.state === 'running') {
            await audioContext.close();
        }
        
        const messagesContainer = document.getElementById('chatMessages');
        if (messagesContainer) {
            messagesContainer.innerHTML = `
                <div class="message assistant">
                    <div class="message-content">
                        你好！我是AI智能助手，可以帮你解答问题、分析数据、生成图表等。你可以通过文字输入、语音输入或开启实时语音对话与我交流。
                        <div class="timestamp">${formatTime(new Date())}</div>
                    </div>
                    <div class="message-controls">
                        <button class="play-audio-btn" onclick="playMessageAudio(this)" title="播放语音">🔊</button>
                    </div>
                </div>
            `;
        }
        
        // 重置状态
        conversationId = '';
        messageCount = 1;
        isLoading = false;
        currentPlayingMessage = null;
        
        const conversationIdElement = document.getElementById('conversationId');
        if (conversationIdElement) {
            conversationIdElement.textContent = '等待开始';
        }
        
        updateMessageCount();
        updateStatus('对话已清空');
        setTimeout(() => updateStatus(''), 2000);
        
        setInputsEnabled(true);
        
    } catch (error) {
        console.error('清空对话失败:', error);
        updateStatus('清空对话时发生错误');
    }
}