// 小普同学语音助手 JavaScript 实现

/**
 * 同步读取YAML文件并加载到Map中
 * 注意：同步XHR会阻塞浏览器，不推荐在生产环境使用
 */
function loadYamlToMapSync(yamlFilePath = 'config/total_config.yml') {
    const configMap = new Map();
    const xhr = new XMLHttpRequest();
    
    try {
        // 同步请求（第三个参数为false）
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

// 声明全局CONFIG变量
let CONFIG;

// 同步初始化配置
function initConfigSync() {
    const configMap = loadYamlToMapSync();
    
    // 从Map中获取配置
    const apiToken = configMap.get('apiToken');
    const apiBase = configMap.get('API_BASE');
    
    // 初始化CONFIG
    CONFIG = {
        API_BASE: apiBase,
        RECORDING_TIMEOUT: 10000, // 这意味着录音开始后，如果超过5秒用户还没有说完（或者没有被静默检测到），录音会自动停止。
        SILENCE_THRESHOLD: 0.01, //  volume 是一个在 0.0 (完全静音) 到 1.0 (最大音量) 之间的小数。
        SILENCE_DURATION: 2000,
        VOICE_DETECTION_THRESHOLD: 0.08, // 声音检测阈值降低以提高敏感度
        QUESTION_DELAY: 2000, // 2秒无声后询问
        VOICE_DETECTION_INTERVAL: 10, // 声音检测间隔（毫秒）
        VOICE_START_DELAY: 100, // 检测到声音后多久开始录音（毫秒）
        TTS: {  
            apiToken: apiToken,
            voice: 'fnlp/MOSS-TTSD-v0.5:anna',
            enabled: true,
            timeout: 30000,
            speed: 2.5
        }
    };
    
    console.log('CONFIG初始化完成:', CONFIG);
}


// 音频队列缓冲类
class AudioBuffer {
    constructor(bufferDuration = 3000) {
        this.bufferDuration = bufferDuration; // 3秒缓冲
        this.buffer = [];
        this.isRecording = false;
        this.stream = null;
        this.processor = null;
    }

    initialize(audioContext, stream) {
        this.stream = stream;
        const source = audioContext.createMediaStreamSource(stream);
        
        // 创建ScriptProcessor来实时采集音频数据
        this.processor = audioContext.createScriptProcessor(4096, 1, 1);
        source.connect(this.processor);
        this.processor.connect(audioContext.destination);
        
        this.processor.onaudioprocess = (event) => {
            if (!this.isRecording) {
                // 即使不在录音状态，也要维护缓冲
                this.addToBuffer(event.inputBuffer);
                this.trimBuffer();
            }
        };
    }

    addToBuffer(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0);
        const data = new Float32Array(channelData);
        
        this.buffer.push({
            data: data,
            timestamp: Date.now()
        });
    }

    trimBuffer() {
        const cutoffTime = Date.now() - this.bufferDuration;
        this.buffer = this.buffer.filter(item => item.timestamp > cutoffTime);
    }

    getBufferedAudio(fromTimestamp) {
        // 获取从指定时间戳开始的缓冲音频
        return this.buffer.filter(item => item.timestamp >= fromTimestamp);
    }

    startRecording(fromTimestamp = null) {
        this.isRecording = true;
        
        // 如果指定了开始时间戳，从缓冲中获取之前的音频
        if (fromTimestamp) {
            const bufferedData = this.getBufferedAudio(fromTimestamp);
            return bufferedData;
        }
        return [];
    }

    stopRecording() {
        this.isRecording = false;
        return [...this.buffer]; // 返回当前所有缓冲数据
    }

    destroy() {
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        this.buffer = [];
    }
}

// 全局状态
let state = {
    isListening: false,
    isRecording: false,
    isProcessing: false,
    mediaRecorder: null,
    audioContext: null,
    analyser: null,
    micPermissionGranted: false,
    conversationId: '',
    recordingTimer: null,
    silenceTimer: null,
    lastVolume: 0,
    animationId: null,
    // 添加TTS服务引用
    ttsService: null,
    // 连续监听相关状态
    continuousMonitoring: false,
    voiceDetectionTimer: null,
    questionTimer: null,
    lastVoiceTime: 0,
    // 音频队列缓冲
    audioBuffer: null,
    voiceStartTime: null,
    // 中断控制
    shouldInterrupt: false,
    isInterrupted: false,  // 标记当前会话是否被中断
    currentStreamReader: null,  // 当前流式读取器引用
    interruptTimestamp: 0  // 中断时间戳
};

// DOM 元素缓存
let elements = {};

// 在文件顶部立即初始化配置
initConfigSync();

// 修改DOMContentLoaded事件处理
document.addEventListener('DOMContentLoaded', async () => {
    // 确保配置已加载
    if (!CONFIG) {
        initConfigSync();
    }
    
    initializeElements();
    updateInitTime();
    initializeTTS();
    await checkMicrophonePermission();
});

// 添加TTS初始化函数
function initializeTTS() {
    try {
        // 初始化TTS服务
        state.ttsService = new TTSService(CONFIG.TTS);
        
        // 设置TTS回调函数
        state.ttsService.setCallbacks({
            onStart: (text) => {
                console.log('🔊 TTS开始播放:', text);
                
                // 检查是否在开始播放前就被中断
                if (state.isInterrupted || state.shouldInterrupt) {
                    console.log('🚨 TTS在开始播放时发现已被中断，立即停止');
                    if (state.ttsService) {
                        state.ttsService.stop();
                    }
                    return;
                }
                
                updateStatus('🔊 小普正在说话... (说话或按ESC可中断)', 'speaking');
                state.shouldInterrupt = false; // 重置中断标志
                state.isInterrupted = false;   // 重置中断状态
                console.log('TTS播放开始，现在可以通过声音中断');
            },
            onEnd: () => {
                console.log('✅ TTS播放完成');
                
                // 清理中断标志
                state.shouldInterrupt = false;
                state.isInterrupted = false;
                
                // 恢复连续监听状态（只有在未被中断的情况下）
                if (state.continuousMonitoring) {
                    updateStatus('连续监听中...', 'listening');
                    // 连续监听会自动继续
                } else {
                    updateStatus('准备就绪', 'ready');
                }
            },
            onError: (error) => {
                console.error('❌ TTS播放错误:', error);
                
                // 清理中断标志
                state.shouldInterrupt = false;
                state.isInterrupted = false;
                
                // 区分是错误还是中断
                if (error.message && error.message.includes('中断')) {
                    console.log('🚨 TTS被中断');
                } else {
                    showError('语音播放失败: ' + error.message);
                }
                
                // 错误时也要恢复监听
                if (state.continuousMonitoring) {
                    updateStatus('连续监听中...', 'listening');
                }
            },
            onProgress: (progress) => {
                // 可选：显示播放进度
                // console.log('TTS播放进度:', Math.round(progress.progress * 100) + '%');
            }
        });
        
        console.log('TTS服务初始化成功');
    } catch (error) {
        console.error('TTS初始化失败:', error);
        showError('语音合成服务初始化失败');
    }
}


// 初始化DOM元素
function initializeElements() {
    elements = {
        statusDot: document.getElementById('statusDot'),
        statusPanel: document.getElementById('statusPanel'),
        statusText: document.getElementById('statusText'),
        statusDetail: document.getElementById('statusDetail'),
        conversation: document.getElementById('conversation'),
        toggleBtn: document.getElementById('toggleBtn'),
        toggleIcon: document.getElementById('toggleIcon'),
        toggleText: document.getElementById('toggleText'),
        permissionPrompt: document.getElementById('permissionPrompt'),
        errorMessage: document.getElementById('errorMessage'),
        visualizerCanvas: document.getElementById('visualizerCanvas'),
        visualizerPlaceholder: document.getElementById('visualizerPlaceholder'),
    };
}

// 更新初始化时间
function updateInitTime() {
    const initTimeElement = document.getElementById('initTime');
    if (initTimeElement) {
        initTimeElement.textContent = new Date().toLocaleTimeString();
    }
}

// 检查麦克风权限
async function checkMicrophonePermission() {
    try {
        const permission = await navigator.permissions.query({ name: 'microphone' });
        
        if (permission.state === 'granted') {
            state.micPermissionGranted = true;
            await initializeAudio();
        } else if (permission.state === 'prompt') {
            showPermissionPrompt();
        } else {
            showError('麦克风权限被拒绝，无法使用语音功能');
        }
    } catch (error) {
        console.error('权限检查失败:', error);
        showPermissionPrompt();
    }
}

// 请求麦克风权限 (全局函数，供HTML调用)
window.requestMicrophonePermission = async function() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        
        state.micPermissionGranted = true;
        hidePermissionPrompt();
        await initializeAudio();
    } catch (error) {
        console.error('麦克风权限请求失败:', error);
        showError('无法获取麦克风权限，请检查浏览器设置');
    }
};

// 初始化音频设备
async function initializeAudio() {
    try {
        updateStatus('初始化音频设备...', 'loading');
        
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                channelCount: 1,  // 新增这行
                sampleRate: 16000
            } 
        });

        // 创建音频上下文
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        state.analyser = state.audioContext.createAnalyser();
        const source = state.audioContext.createMediaStreamSource(stream);
        source.connect(state.analyser);

        // 初始化音频缓冲
        state.audioBuffer = new AudioBuffer();
        state.audioBuffer.initialize(state.audioContext, stream);

        // 配置分析器
        state.analyser.fftSize = 256;
        state.analyser.smoothingTimeConstant = 0.8;

        // 检查支持的音频格式
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/wav'
        ];

        let selectedMimeType = null;
        for (const mimeType of mimeTypes) {
            if (MediaRecorder.isTypeSupported(mimeType)) {
                selectedMimeType = mimeType;
                break;
            }
        }

        // 创建录音器
        if (selectedMimeType) {
            state.mediaRecorder = new MediaRecorder(stream, {
                mimeType: selectedMimeType
            });
        } else {
            state.mediaRecorder = new MediaRecorder(stream);
        }

        console.log('使用音频格式:', selectedMimeType || 'default');

        setupMediaRecorder();
        startContinuousMonitoring();

        updateStatus('连续监听中...', 'listening');
        console.log('音频初始化成功，开始连续监听');
    } catch (error) {
        console.error('音频初始化失败:', error);
        showError('音频设备初始化失败: ' + error.message);
    }
}

// 配置录音器事件
function setupMediaRecorder() {
    let audioChunks = [];

    state.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    };

    state.mediaRecorder.onstop = async () => {
        if (audioChunks.length > 0) {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            audioChunks = [];
            await processAudio(audioBlob);
        }
    };

    state.mediaRecorder.onerror = (error) => {
        console.error('录音错误:', error);
        showError('录音失败: ' + error.error);
        stopRecording();
    };
}

// 开始连续监听
function startContinuousMonitoring() {
    if (!state.micPermissionGranted || state.continuousMonitoring) return;

    state.continuousMonitoring = true;
    state.isListening = true;
    updateStatus('连续监听中...', 'listening');
    updateToggleButton(true);
    
    // 开始音频可视化
    startAudioVisualization();
    
    // 开始连续声音检测
    startVoiceDetection();

    console.log('开始连续声音监听');
}

// 停止连续监听
function stopContinuousMonitoring() {
    state.continuousMonitoring = false;
    state.isListening = false;
    updateStatus('已停止监听', 'stopped');
    updateToggleButton(false);
    
    // 停止音频可视化
    stopAudioVisualization();
    
    // 清理定时器
    if (state.voiceDetectionTimer) {
        clearTimeout(state.voiceDetectionTimer);
        state.voiceDetectionTimer = null;
    }
    if (state.questionTimer) {
        clearTimeout(state.questionTimer);
        state.questionTimer = null;
    }

    console.log('停止连续监听');
}

// 切换监听状态 (全局函数，供HTML调用)
window.toggleListening = function() {
    if (state.continuousMonitoring) {
        stopContinuousMonitoring();
    } else {
        startContinuousMonitoring();
    }
};

// 全局中断函数 - 中断所有当前进程
function executeGlobalInterrupt() {
    console.log('🚨 执行全局中断...');
    
    // 设置中断状态
    state.isInterrupted = true;
    state.shouldInterrupt = false;
    
    // 1. 中断流式响应读取
    if (state.currentStreamReader) {
        try {
            console.log('中断流式响应读取...');
            state.currentStreamReader.cancel();
            state.currentStreamReader = null;
        } catch (error) {
            console.warn('中断流式读取失败:', error);
        }
    }
    
    // 2. 停止TTS播放
    if (state.ttsService && state.ttsService.isSpeaking()) {
        console.log('停止TTS播放...');
        state.ttsService.stop();
    }
    
    // 3. 重置状态
    state.isProcessing = false;
    elements.statusPanel.classList.remove('processing', 'active');
    
    // 4. 更新状态显示
    updateStatus('ℹ️ 已中断当前回答，连续监听中...', 'listening');
    
    // 5. 如果还在检测到声音，开始新的录音
    setTimeout(() => {
        state.isInterrupted = false;  // 重置中断标志
        // 检查是否还在检测到声音，如果是则开始录音
        if (state.lastVolume > CONFIG.VOICE_DETECTION_THRESHOLD && !state.isRecording) {
            console.log('中断后检测到持续声音，开始新录音...');
            startRecording();
        }
    }, 100);
    
    console.log('✅ 全局中断完成');
}

// 手动中断功能 (全局函数，供HTML调用)
window.interruptTTS = function() {
    if (state.isProcessing || (state.ttsService && state.ttsService.isSpeaking())) {
        state.shouldInterrupt = true;
        executeGlobalInterrupt();
        console.log('手动触发中断');
    }
};

// 清空对话 (全局函数，供HTML调用)
window.clearConversation = function() {
    elements.conversation.innerHTML = `
        <div class="message assistant">
            <div class="message-header">
                <span class="icon">🤖</span>
                <span>小普同学</span>
            </div>
            <div class="message-content">
                对话已清空。现在处于连续监听模式，检测到声音时会自动开始录音。
            </div>
            <div class="message-time">${new Date().toLocaleTimeString()}</div>
        </div>
    `;
    state.conversationId = '';
};

// 连续声音检测 - 优化版本
function startVoiceDetection() {
    if (!state.continuousMonitoring || !state.analyser) return;
    
    let consecutiveVoiceFrames = 0;
    let consecutiveSilenceFrames = 0;
    const VOICE_CONFIRM_FRAMES = 3; // 连续3帧检测到声音才确认
    const SILENCE_CONFIRM_FRAMES = Math.ceil(CONFIG.QUESTION_DELAY / CONFIG.VOICE_DETECTION_INTERVAL); // 2秒静音帧数
    
    const checkVoiceLevel = () => {
        if (!state.continuousMonitoring) return;
        
        // 获取音频数据 - 无论是否在播放TTS都要检测
        const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
        state.analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        const volume = average / 255;
        
        // 检查是否需要中断当前进程
        if (state.shouldInterrupt && (state.isProcessing || (state.ttsService && state.ttsService.isSpeaking()))) {
            console.log('🚨 执行全局中断...', {
                shouldInterrupt: state.shouldInterrupt,
                isProcessing: state.isProcessing,
                isTTSSpeaking: state.ttsService ? state.ttsService.isSpeaking() : false
            });
            
            // 执行全局中断
            executeGlobalInterrupt();
        }
        
        // 声音检测逻辑
        if (volume > CONFIG.VOICE_DETECTION_THRESHOLD) {
            consecutiveVoiceFrames++;
            consecutiveSilenceFrames = 0;
            
            // 第一次检测到声音时记录时间和检查中断
            if (consecutiveVoiceFrames === 1) {
                if (!state.voiceStartTime) {
                    state.voiceStartTime = Date.now();
                    console.log('检测到声音开始...');
                }
                
                // 如果当前在处理请求或TTS播放，设置中断标志
                if (state.isProcessing || (state.ttsService && state.ttsService.isSpeaking())) {
                    state.shouldInterrupt = true;
                    state.interruptTimestamp = Date.now();
                    console.log('🎤 检测到声音，准备中断当前进程...', {
                        volume: volume.toFixed(3),
                        threshold: CONFIG.VOICE_DETECTION_THRESHOLD,
                        isProcessing: state.isProcessing,
                        isTTSSpeaking: state.ttsService ? state.ttsService.isSpeaking() : false,
                        consecutiveFrames: consecutiveVoiceFrames
                    });
                }
            }
            
            // 连续检测到足够声音帧后开始录音（即使TTS在播放也可以录音）
            if (consecutiveVoiceFrames >= VOICE_CONFIRM_FRAMES && !state.isRecording && !state.isProcessing) {
                console.log('确认声音输入，开始录音');
                // 如果TTS正在播放，先停止它
                if (state.ttsService && state.ttsService.isSpeaking()) {
                    state.ttsService.stop();
                    console.log('停止TTS播放以开始录音');
                }
                startRecording();
            }
            
            state.lastVoiceTime = Date.now();
        } else {
            consecutiveSilenceFrames++;
            consecutiveVoiceFrames = 0;
            
            // 如果之前检测到了声音但现在静音，重置声音开始时间
            if (state.voiceStartTime && !state.isRecording) {
                state.voiceStartTime = null;
            }
            
            // 如果当前在录音中且连续静音超过阈值，停止录音
            if (state.isRecording && consecutiveSilenceFrames >= SILENCE_CONFIRM_FRAMES) {
                console.log('2秒无声确认，停止录音');
                stopRecording();
                consecutiveSilenceFrames = 0;
            }
        }
        
        state.lastVolume = volume;
        
        // 调试信息 - 每100次检测输出一次状态
        if (Math.random() < 0.01) { // 约1%的概率输出
            console.log('声音检测状态:', {
                volume: volume.toFixed(3),
                threshold: CONFIG.VOICE_DETECTION_THRESHOLD,
                consecutiveVoice: consecutiveVoiceFrames,
                consecutiveSilence: consecutiveSilenceFrames,
                isRecording: state.isRecording,
                isTTSSpeaking: state.ttsService ? state.ttsService.isSpeaking() : false,
                shouldInterrupt: state.shouldInterrupt
            });
        }
        
        setTimeout(checkVoiceLevel, CONFIG.VOICE_DETECTION_INTERVAL);
    };
    
    checkVoiceLevel();
}

// 语音被检测到时的处理
function onVoiceDetected() {
    console.log('检测到语音输入');
    updateStatus('检测到语音，开始录音...', 'recording');
    
    // 可选：播放提示音
    // playNotificationSound();
}

// 播放提示音
function playNotificationSound() {
    if (state.audioContext) {
        const oscillator = state.audioContext.createOscillator();
        const gainNode = state.audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(state.audioContext.destination);
        
        oscillator.frequency.setValueAtTime(800, state.audioContext.currentTime);
        oscillator.frequency.setValueAtTime(1000, state.audioContext.currentTime + 0.1);
        
        gainNode.gain.setValueAtTime(0.1, state.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, state.audioContext.currentTime + 0.2);
        
        oscillator.start(state.audioContext.currentTime);
        oscillator.stop(state.audioContext.currentTime + 0.2);
    }
}

// 开始录音 - 优化版本
function startRecording() {
    if (state.isRecording || !state.mediaRecorder) return;

    try {
        // 从缓冲中获取之前的音频数据（如果有的话）
        let bufferedData = [];
        if (state.audioBuffer && state.voiceStartTime) {
            bufferedData = state.audioBuffer.startRecording(state.voiceStartTime);
            console.log(`从缓冲获取了 ${bufferedData.length} 帧音频数据`);
        }
        
        state.isRecording = true;
        state.mediaRecorder.start(100); // 使用100ms的时间片段以获得更好的实时性
        
        updateStatus('正在录音...', 'recording');
        elements.statusPanel.classList.remove('wakened');
        elements.statusPanel.classList.add('active');

        // 设置录音超时
        state.recordingTimer = setTimeout(() => {
            if (state.isRecording) {
                console.log('录音超时，自动停止');
                stopRecording();
            }
        }, CONFIG.RECORDING_TIMEOUT);

        console.log('开始录音（含缓冲数据）');
    } catch (error) {
        console.error('录音启动失败:', error);
        showError('录音启动失败');
        state.isRecording = false;
        state.voiceStartTime = null;
    }
}

// 停止录音 - 优化版本
function stopRecording() {
    if (!state.isRecording) return;

    state.isRecording = false;
    
    try {
        // 停止缓冲并获取所有数据
        let allBufferedData = [];
        if (state.audioBuffer) {
            allBufferedData = state.audioBuffer.stopRecording();
        }
        
        state.mediaRecorder.stop();
        updateStatus('录音结束，正在处理...', 'processing');
        elements.statusPanel.classList.remove('active');
        elements.statusPanel.classList.add('processing');

        // 清除定时器和重置状态
        if (state.recordingTimer) {
            clearTimeout(state.recordingTimer);
            state.recordingTimer = null;
        }
        
        // 重置声音检测状态
        state.voiceStartTime = null;

        console.log(`停止录音，共获取 ${allBufferedData.length} 帧缓冲数据`);
    } catch (error) {
        console.error('停止录音失败:', error);
        state.voiceStartTime = null;
    }
}

// 静默检测
function startSilenceDetection() {
    if (!state.analyser) return;

    const detectSilence = () => {
        if (!state.isRecording) return;

        const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
        state.analyser.getByteFrequencyData(dataArray);
        
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        const volume = average / 255;

        if (volume < CONFIG.SILENCE_THRESHOLD) {
            if (!state.silenceTimer) {
                state.silenceTimer = setTimeout(() => {
                    if (state.isRecording) {
                        console.log('检测到静默，停止录音');
                        stopRecording();
                    }
                }, CONFIG.SILENCE_DURATION);
            }
        } else {
            if (state.silenceTimer) {
                clearTimeout(state.silenceTimer);
                state.silenceTimer = null;
            }
        }

        state.lastVolume = volume;
        requestAnimationFrame(detectSilence);
    };

    detectSilence();
}

// 停止静默检测
function stopSilenceDetection() {
    if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = null;
    }
}

// 处理音频
async function processAudio(audioBlob) {
    try {
        state.isProcessing = true;
        updateStatus('正在识别语音...', 'processing');
        
        // 检查中断状态
        if (state.isInterrupted || state.shouldInterrupt) {
            console.log('🚨 音频处理被中断');
            return;
        }

        // 调用STT API
        const transcript = await callSTTAPI(audioBlob);
        
        if (transcript.trim()) {
            // 再次检查中断状态
            if (state.isInterrupted || state.shouldInterrupt) {
                console.log('🚨 在STT完成后被中断');
                return;
            }
            
            addMessage(transcript, 'user');
            
            // 调用对话API前最后一次检查
            if (!state.isInterrupted && !state.shouldInterrupt) {
                await callChatAPI(transcript);
            } else {
                console.log('🚨 在调用对话API前被中断');
            }
        } else {
            updateStatus('未识别到语音内容', 'ready');
            setTimeout(() => {
                if (state.isListening) {
                    updateStatus('监听中...', 'listening');
                }
            }, 2000);
        }

    } catch (error) {
        console.error('音频处理失败:', error);
        showError('语音处理失败: ' + error.message);
    } finally {
        state.isProcessing = false;
        elements.statusPanel.classList.remove('processing');
        
        // 如果被中断，立即恢复监听状态
        if (state.isInterrupted || state.shouldInterrupt) {
            console.log('🔄 音频处理被中断，恢复监听状态');
            executeGlobalInterrupt();
        } else if (state.continuousMonitoring) {
            setTimeout(() => {
                if (!state.isInterrupted && !state.shouldInterrupt) {
                    updateStatus('连续监听中...', 'listening');
                }
            }, 1000);
        }
    }
}

// 调用STT API
async function callSTTAPI(audioBlob) {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.webm');
    formData.append('language', 'auto');

    const response = await fetch(`${CONFIG.API_BASE}/transcribe`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`STT API错误: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result.text || '';
}

// 调用对话API
async function callChatAPI(query) {
    try {
        updateStatus('小普正在思考...', 'processing');

        const response = await fetch(`${CONFIG.API_BASE}/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: query,
                conversation_id: state.conversationId,
            }),
        });

        if (!response.ok) {
            throw new Error(`对话API错误: ${response.status} ${response.statusText}`);
        }

        // 处理流式响应
        await handleStreamResponse(response);

    } catch (error) {
        console.error('对话API调用失败:', error);
        showError('对话失败: ' + error.message);
        addMessage('抱歉，我现在无法回应，请稍后再试。', 'assistant');
    }
}

// 处理流式响应
// 修改handleStreamResponse函数，在workflow_finished事件中添加TTS调用
async function handleStreamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let completeAnswer = '';
    let messageElement = null;
    
    // 设置当前流读取器引用，以便可以中断
    state.currentStreamReader = reader;

    try {
        while (true) {
            // 检查中断标志
            if (state.isInterrupted || state.shouldInterrupt) {
                console.log('🚨 流式响应被中断');
                if (messageElement) {
                    updateMessageContent(messageElement, completeAnswer + ' [被中断]');
                }
                break;
            }
            
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        
                        if (data.event === 'workflow_started') {
                            state.conversationId = data.conversation_id || state.conversationId;
                            messageElement = addMessage('', 'assistant');
                        } else if (data.event === 'message') {
                            completeAnswer = data.complete_answer || '';
                            if (messageElement) {
                                updateMessageContent(messageElement, completeAnswer);
                            }
                        } else if (data.event === 'workflow_finished') {
                            // 再次检查中断标志
                            if (state.isInterrupted || state.shouldInterrupt) {
                                console.log('🚨 在workflow_finished事件处理时被中断');
                                break;
                            }
                            
                            const finalAnswer = data.final_answer || completeAnswer;
                            if (messageElement) {
                                // 更新消息内容
                                updateMessageContent(messageElement, finalAnswer);
                                
                                // 【核心修改】TTS播放前再次检查中断
                                if (finalAnswer.trim() && state.ttsService && !state.isInterrupted && !state.shouldInterrupt) {
                                    try {
                                        console.log('🔊 开始TTS播放（中断检查通过）');
                                        await state.ttsService.speak(finalAnswer);
                                    } catch (error) {
                                        console.error('TTS播放失败:', error);
                                        // 即使TTS失败也要恢复监听状态
                                        if (state.continuousMonitoring && !state.isInterrupted) {
                                            updateStatus('连续监听中...', 'listening');
                                        }
                                    }
                                } else {
                                    console.log('跳过TTS播放：', {
                                        hasAnswer: !!finalAnswer.trim(),
                                        hasTTSService: !!state.ttsService,
                                        isInterrupted: state.isInterrupted,
                                        shouldInterrupt: state.shouldInterrupt
                                    });
                                    
                                    if (state.continuousMonitoring && !state.isInterrupted) {
                                        updateStatus('连续监听中...', 'listening');
                                    } else {
                                        updateStatus('回答完成', 'ready');
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('解析流式数据失败:', e);
                    }
                }
            }
        }
    } catch (error) {
        console.error('读取流式响应失败:', error);
        if (messageElement && !state.isInterrupted) {
            updateMessageContent(messageElement, '抱歉，回答被中断了。');
        }
    } finally {
        // 清理流读取器引用
        state.currentStreamReader = null;
        try {
            reader.releaseLock();
        } catch (e) {
            // 忽略锁释放错误
        }
    }
}

// 添加消息
function addMessage(content, type) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    messageDiv.innerHTML = `
        <div class="message-header">
            <span class="icon">${type === 'user' ? '👤' : '🤖'}</span>
            <span>${type === 'user' ? '用户' : '小普同学'}</span>
        </div>
        <div class="message-content">${content}</div>
        <div class="message-time">${new Date().toLocaleTimeString()}</div>
    `;

    elements.conversation.appendChild(messageDiv);
    elements.conversation.scrollTop = elements.conversation.scrollHeight;

    return messageDiv;
}

// 更新消息内容
function updateMessageContent(messageElement, content) {
    const contentElement = messageElement.querySelector('.message-content');
    if (contentElement) {
        contentElement.textContent = content;
    }
}

// 音频可视化
function startAudioVisualization() {
    if (!state.analyser) return;

    const canvas = elements.visualizerCanvas;
    const ctx = canvas.getContext('2d');
    elements.visualizerPlaceholder.style.display = 'none';
    canvas.style.display = 'block';

    const animate = () => {
        if (!state.continuousMonitoring && !state.isRecording) {
            canvas.style.display = 'none';
            elements.visualizerPlaceholder.style.display = 'flex';
            return;
        }

        const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
        state.analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';

        const barWidth = canvas.width / dataArray.length;
        let x = 0;

        for (let i = 0; i < dataArray.length; i++) {
            const barHeight = (dataArray[i] / 255) * canvas.height * 0.8;
            ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
            x += barWidth;
        }

        state.animationId = requestAnimationFrame(animate);
    };

    animate();
}

// 停止音频可视化
function stopAudioVisualization() {
    if (state.animationId) {
        cancelAnimationFrame(state.animationId);
        state.animationId = null;
    }
}

// 更新状态显示
function updateStatus(text, status) {
    elements.statusText.textContent = text;
    
    elements.statusDot.className = 'status-dot';
    if (status) {
        elements.statusDot.classList.add(status);
    }

    const statusDetails = {
        loading: '正在初始化系统组件...',
        ready: '准备就绪',
        listening: '连续监听中，检测到声音会自动开始录音...',
        recording: '录音中，2秒无声后自动提问',
        processing: '正在处理您的请求...',
        speaking: '正在播放回答，随时可以说话中断或按ESC键', // 新增TTS播放状态
        stopped: '监听已暂停',
    };
    
    elements.statusDetail.textContent = statusDetails[status] || '';
}


// 更新切换按钮
function updateToggleButton(isListening) {
    elements.toggleIcon.textContent = isListening ? '⏸️' : '▶️';
    elements.toggleText.textContent = isListening ? '暂停监听' : '开始监听';
    elements.toggleBtn.disabled = state.isProcessing;
}

// 显示权限提示
function showPermissionPrompt() {
    elements.permissionPrompt.classList.add('show');
}

// 隐藏权限提示
function hidePermissionPrompt() {
    elements.permissionPrompt.classList.remove('show');
}

// 显示错误信息
function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.classList.add('show');
    
    // 5秒后自动隐藏
    setTimeout(() => {
        elements.errorMessage.classList.remove('show');
    }, 5000);
}

// 错误处理
window.addEventListener('error', (event) => {
    console.error('全局错误:', event.error);
    showError('系统错误: ' + event.error.message);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('未处理的Promise拒绝:', event.reason);
    showError('网络或服务错误，请检查连接');
});

// 页面卸载时清理资源
window.addEventListener('beforeunload', () => {
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
    }
    if (state.audioContext) {
        state.audioContext.close();
    }
    // 清理音频缓冲
    if (state.audioBuffer) {
        state.audioBuffer.destroy();
    }
    // 清理TTS资源
    if (state.ttsService) {
        state.ttsService.destroy();
    }
    // 清理连续监听定时器
    if (state.voiceDetectionTimer) {
        clearTimeout(state.voiceDetectionTimer);
    }
    if (state.questionTimer) {
        clearTimeout(state.questionTimer);
    }
});

// 添加键盘快捷键支持
document.addEventListener('keydown', (event) => {
    // 按ESC键中断TTS播放
    if (event.key === 'Escape') {
        if (state.ttsService && state.ttsService.isSpeaking()) {
            window.interruptTTS();
            event.preventDefault();
        }
    }
    // 按空格键切换监听状态
    if (event.key === ' ' && event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') {
        window.toggleListening();
        event.preventDefault();
    }
});

console.log('小普同学语音助手已加载');
console.log('快捷键说明: ESC中断播放, 空格切换监听');


// 添加TTS控制的全局函数
window.toggleTTS = function() {
    if (state.ttsService) {
        const newState = !state.ttsService.config.enabled;
        state.ttsService.setEnabled(newState);
        console.log('TTS功能:', newState ? '已启用' : '已禁用');
        
        // 可以在UI上显示TTS状态变化
        const statusText = newState ? 'TTS已启用' : 'TTS已禁用';
        showError(statusText, false); // 复用错误显示功能来显示状态
    }
};

// 停止TTS播放
window.stopTTS = function() {
    if (state.ttsService) {
        state.ttsService.stop();
        state.shouldInterrupt = false;
        if (state.continuousMonitoring) {
            updateStatus('连续监听中...', 'listening');
        }
        console.log('TTS播放已停止');
    }
};

// 设置TTS语音类型
window.setTTSVoice = function(voice) {
    if (state.ttsService) {
        state.ttsService.setConfig({ voice: voice });
        console.log('TTS语音已设置为:', voice);
    }
};

// 测试TTS中断功能
window.testTTSInterrupt = function() {
    if (state.ttsService) {
        console.log('🎤 开始测试TTS中断功能...');
        // 播放一段测试文本
        state.ttsService.speak('这是一段测试语音，你可以通过说话来中断我。现在请尝试说话来测试中断功能。说话阈值设置为' + CONFIG.VOICE_DETECTION_THRESHOLD)
            .then(() => {
                console.log('✅ 测试TTS播放完成');
            })
            .catch((error) => {
                console.log('❌ 测试TTS被中断或出错:', error);
            });
    } else {
        console.log('❌ TTS服务未初始化');
    }
};

// 获取当前状态信息
window.getSystemStatus = function() {
    console.log('🔍 系统状态信息:', {
        continuousMonitoring: state.continuousMonitoring,
        isRecording: state.isRecording,
        isProcessing: state.isProcessing,
        isTTSSpeaking: state.ttsService ? state.ttsService.isSpeaking() : false,
        shouldInterrupt: state.shouldInterrupt,
        isInterrupted: state.isInterrupted,
        voiceThreshold: CONFIG.VOICE_DETECTION_THRESHOLD,
        lastVolume: state.lastVolume,
        hasAudioBuffer: !!state.audioBuffer,
        hasCurrentStreamReader: !!state.currentStreamReader
    });
};