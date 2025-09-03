// 小普同学语音助手 JavaScript 实现

/**
 * 同步读取YAML文件并加载到Map中
 * @param {string} yamlFilePath - YAML配置文件的路径
 * @returns {Map<string, string>} - 包含配置键值对的Map
 * @description 注意：同步XHR会阻塞浏览器主线程，导致UI卡顿。
 *              此方法仅适用于在应用初始化时加载少量关键配置。
 *              生产环境中推荐使用异步方式（如fetch）加载配置。
 */
function loadYamlToMapSync(yamlFilePath = 'config/total_config.yml') {
    // 创建一个Map来存储解析后的配置
    const configMap = new Map();
    // 创建一个同步的XMLHttpRequest对象
    const xhr = new XMLHttpRequest();
    
    try {
        // 打开一个同步GET请求（第三个参数为false表示同步）
        xhr.open('GET', yamlFilePath, false);
        // 发送请求
        xhr.send(null);
        
        // 检查HTTP响应状态码
        if (xhr.status !== 200) {
            // 如果请求失败，抛出错误
            throw new Error(`无法加载YAML文件: ${xhr.status} ${xhr.statusText}`);
        }
        
        // 获取响应文本内容
        const yamlContent = xhr.responseText;
        // 按行分割YAML内容
        const lines = yamlContent.split('\n');
        
        // 遍历每一行进行解析
        for (const line of lines) {
            const trimmedLine = line.trim();
            // 跳过空行或注释行（以#开头）
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;
            
            // 寻找第一个冒号作为键和值的分隔符
            const colonIndex = trimmedLine.indexOf(':');
            if (colonIndex === -1) continue; // 跳过没有冒号的行
            
            // 提取键和值
            const key = trimmedLine.substring(0, colonIndex).trim();
            const value = trimmedLine.substring(colonIndex + 1).trim();
            // 存入Map
            configMap.set(key, value);
        }
        
        console.log(`成功加载YAML配置，共${configMap.size}项`);
        return configMap;
        
    } catch (error) {
        console.error('加载YAML文件失败:', error);
        // 如果发生错误，返回一个空的Map
        return configMap;
    }
}

// 声明全局配置变量
let CONFIG;

/**
 * 同步初始化应用配置
 * @description 从YAML文件加载配置，并设置到全局CONFIG对象中。
 */
function initConfigSync() {
    // 调用函数加载YAML配置到Map
    const configMap = loadYamlToMapSync();
    
    // 从Map中获取特定的配置项
    const apiToken = configMap.get('apiToken');
    const apiBase = configMap.get('API_BASE');
    
    // 初始化全局CONFIG对象
    CONFIG = {
        API_BASE: apiBase, // 后端API的基础URL
        RECORDING_TIMEOUT: 10000, // 最大录音时长（毫秒），防止无限录音
        SILENCE_THRESHOLD: 0.1, // 静音检测的音量阈值 (0.0-1.0)
        SILENCE_DURATION: 1500, // 判定为静默需要持续的时长（毫秒）
        VOICE_DETECTION_THRESHOLD: 0.2, // 声音活动检测的音量阈值，用于唤醒或中断
        QUESTION_DELAY: 1000, // 检测到声音后，如果持续静音超过此时长，则自动结束录音并提问
        VOICE_DETECTION_INTERVAL: 1, // 声音活动检测的轮询间隔（毫秒）
        VOICE_START_DELAY: 100, // (未使用) 曾用于检测到声音后延迟开始录音
        TTS: {  // 文本转语音（Text-to-Speech）服务的相关配置
            apiToken: apiToken, // TTS服务的API令牌
            voice: 'fnlp/MOSS-TTSD-v0.5:anna', // 使用的语音模型
            enabled: true, // 是否启用TTS功能
            timeout: 30000, // TTS请求的超时时间
            speed: 2.5 // 语速控制
        }
    };
    
    console.log('CONFIG初始化完成:', CONFIG);
}


/**
 * 音频队列缓冲类
 * @description 用于在正式录音开始前，缓存一小段时间的音频数据。
 *              这样可以确保即使用户在“按下录音”前就已经开始说话，这部分语音也不会丢失。
 */
class AudioBuffer {
    /**
     * @param {number} bufferDuration - 缓冲时长（毫秒）
     */
    constructor(bufferDuration = 3000) {
        this.bufferDuration = bufferDuration; // 决定缓冲多长时间的音频
        this.buffer = []; // 存储音频数据块的数组
        this.isRecording = false; // 标记是否正在录音
        this.stream = null; // MediaStream的引用
        this.processor = null; // ScriptProcessorNode的引用
    }

    /**
     * 初始化并连接音频处理节点
     * @param {AudioContext} audioContext - Web Audio API的音频上下文
     * @param {MediaStream} stream - 来自麦克风的音频流
     */
    initialize(audioContext, stream) {
        this.stream = stream;
        const source = audioContext.createMediaStreamSource(stream);
        
        // 创建一个ScriptProcessorNode用于实时处理音频数据
        // 参数: bufferSize, inputChannels, outputChannels
        this.processor = audioContext.createScriptProcessor(4096, 1, 1);
        source.connect(this.processor);
        this.processor.connect(audioContext.destination); // 连接到扬声器以听到声音（调试时有用）
        
        // 设置音频处理回调
        this.processor.onaudioprocess = (event) => {
            // 即使不在录音状态，也持续将音频数据加入缓冲区
            if (!this.isRecording) {
                this.addToBuffer(event.inputBuffer);
                this.trimBuffer(); // 并清理过期的缓冲
            }
        };
    }

    /**
     * 将音频数据块添加到缓冲区
     * @param {AudioBuffer} audioBuffer - 从onaudioprocess事件获取的音频数据
     */
    addToBuffer(audioBuffer) {
        const channelData = audioBuffer.getChannelData(0); // 获取单声道数据
        const data = new Float32Array(channelData); // 复制数据，避免引用问题
        
        this.buffer.push({
            data: data,
            timestamp: Date.now() // 记录数据块的时间戳
        });
    }

    /**
     * 清理缓冲区，移除超过指定缓冲时长的旧数据
     */
    trimBuffer() {
        const cutoffTime = Date.now() - this.bufferDuration;
        this.buffer = this.buffer.filter(item => item.timestamp > cutoffTime);
    }

    /**
     * 获取从指定时间戳开始的缓冲音频
     * @param {number} fromTimestamp - 开始时间戳
     * @returns {Array} - 包含音频数据块的数组
     */
    getBufferedAudio(fromTimestamp) {
        // 获取从指定时间戳开始的缓冲音频
        return this.buffer.filter(item => item.timestamp >= fromTimestamp);
    }

    /**
     * 开始录音，并返回录音开始前一段时间的缓冲数据
     * @param {number|null} fromTimestamp - 如果提供，则从该时间点开始获取缓冲
     * @returns {Array} - 录音开始前的缓冲音频数据
     */
    startRecording(fromTimestamp = null) {
        this.isRecording = true;
        
        // 如果指定了开始时间戳，从缓冲中获取之前的音频
        if (fromTimestamp) {
            const bufferedData = this.getBufferedAudio(fromTimestamp);
            return bufferedData;
        }
        return [];
    }

    /**
     * 停止录音
     * @returns {Array} - 当前所有的缓冲数据
     */
    stopRecording() {
        this.isRecording = false;
        return [...this.buffer]; // 返回当前所有缓冲数据的副本
    }

    /**
     * 销毁并清理资源
     */
    destroy() {
        if (this.processor) {
            this.processor.disconnect(); // 断开音频节点连接
            this.processor = null;
        }
        this.buffer = []; // 清空缓冲区
    }
}

// 全局应用状态管理对象
let state = {
    isListening: false, // 是否处于连续监听模式
    isRecording: false, // 是否正在录音
    isProcessing: false, // 是否正在处理（STT或Chat API调用）
    mediaRecorder: null, // MediaRecorder实例
    audioContext: null, // AudioContext实例
    analyser: null, // AnalyserNode实例，用于音量分析
    micPermissionGranted: false, // 是否已获得麦克风权限
    conversationId: '', // 当前对话的ID
    recordingTimer: null, // 录音超时定时器
    silenceTimer: null, // 静默检测定时器
    lastVolume: 0, // 上一次检测到的音量
    animationId: null, // 音频可视化动画的请求ID
    ttsService: null, // TTS服务实例的引用
    continuousMonitoring: false, // 是否启用连续监听的总开关
    voiceDetectionTimer: null, // (未使用) 声音检测定时器
    questionTimer: null, // (未使用) 提问延迟定时器
    lastVoiceTime: 0, // 最后一次检测到声音的时间戳
    audioBuffer: null, // AudioBuffer实例的引用
    voiceStartTime: null, // 检测到语音开始的时间戳
    shouldInterrupt: false, // 标记是否应该中断当前操作（如TTS播放）
    isInterrupted: false,  // 标记当前会话是否已经被中断
    currentStreamReader: null,  // 对当前流式响应Reader的引用，用于取消
    interruptTimestamp: 0  // 触发中断时的时间戳
};

// 缓存DOM元素的全局对象
let elements = {};

// 在脚本加载时立即初始化配置
initConfigSync();

// 当DOM加载完成后执行初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 再次确保配置已加载
    if (!CONFIG) {
        initConfigSync();
    }
    
    // 初始化DOM元素缓存、更新时间、初始化TTS并检查权限
    initializeElements();
    updateInitTime();
    initializeTTS();
    await checkMicrophonePermission();
});

/**
 * 初始化TTS（文本转语音）服务
 */
function initializeTTS() {
    try {
        // 实例化TTS服务，传入配置
        state.ttsService = new TTSService(CONFIG.TTS);
        
        // 设置TTS服务的生命周期回调函数
        state.ttsService.setCallbacks({
            // TTS开始播放时调用
            onStart: (text) => {
                console.log('🔊 TTS开始播放:', text);
                
                // 播放前检查是否已被中断
                if (state.isInterrupted || state.shouldInterrupt) {
                    console.log('🚨 TTS在开始播放时发现已被中断，立即停止');
                    if (state.ttsService) {
                        state.ttsService.stop();
                    }
                    return;
                }
                
                // 更新UI状态，提示用户可以中断
                updateStatus('🔊 小普正在说话... (说话或按ESC可中断)', 'speaking');
                // 重置中断标志
                state.shouldInterrupt = false;
                state.isInterrupted = false;
                console.log('TTS播放开始，现在可以通过声音中断');
            },
            // TTS播放完成时调用
            onEnd: () => {
                console.log('✅ TTS播放完成');
                
                // 清理中断标志
                state.shouldInterrupt = false;
                state.isInterrupted = false;
                
                // 如果处于连续监听模式，则自动恢复监听状态
                if (state.continuousMonitoring) {
                    updateStatus('连续监听中...', 'listening');
                    // 连续监听会自动继续
                } else {
                    updateStatus('准备就绪', 'ready');
                }
            },
            // TTS发生错误时调用
            onError: (error) => {
                console.error('❌ TTS播放错误:', error);
                
                // 清理中断标志
                state.shouldInterrupt = false;
                state.isInterrupted = false;
                
                // 判断错误是由于中断还是其他原因
                if (error.message && error.message.includes('中断')) {
                    console.log('🚨 TTS被中断');
                } else {
                    showError('语音播放失败: ' + error.message);
                }
                
                // 发生错误后，如果需要，也恢复监听状态
                if (state.continuousMonitoring) {
                    updateStatus('连续监听中...', 'listening');
                }
            },
            // TTS播放进度更新时调用 (可选)
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


/**
 * 缓存页面上的DOM元素引用，提高访问效率
 */
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

/**
 * 更新页面上显示的初始化时间
 */
function updateInitTime() {
    const initTimeElement = document.getElementById('initTime');
    if (initTimeElement) {
        initTimeElement.textContent = new Date().toLocaleTimeString();
    }
}

/**
 * 检查麦克风权限状态
 */
async function checkMicrophonePermission() {
    try {
        // 使用Permissions API查询麦克风权限
        const permission = await navigator.permissions.query({ name: 'microphone' });
        
        if (permission.state === 'granted') {
            // 如果已授权，设置标志并初始化音频
            state.micPermissionGranted = true;
            await initializeAudio();
        } else if (permission.state === 'prompt') {
            // 如果是'prompt'状态，显示请求授权的提示
            showPermissionPrompt();
        } else {
            // 如果被拒绝，显示错误信息
            showError('麦克风权限被拒绝，无法使用语音功能');
        }
    } catch (error) {
        // 在某些浏览器（如旧版Firefox）中，查询可能会失败
        console.error('权限检查失败:', error);
        showPermissionPrompt(); // 失败时也显示提示，让用户手动触发
    }
}

/**
 * 请求麦克风权限
 * @description 这个函数暴露到全局作用域，由HTML中的按钮点击调用
 */
window.requestMicrophonePermission = async function() {
    try {
        // 弹出浏览器原生授权请求
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // 获取到流后立即停止，因为我们只是为了获取权限
        stream.getTracks().forEach(track => track.stop());
        
        state.micPermissionGranted = true;
        hidePermissionPrompt(); // 隐藏授权提示
        await initializeAudio(); // 初始化音频
    } catch (error) {
        console.error('麦克风权限请求失败:', error);
        showError('无法获取麦克风权限，请检查浏览器设置');
    }
};

/**
 * 初始化所有与音频相关的对象和流程
 */
async function initializeAudio() {
    try {
        updateStatus('初始化音频设备...', 'loading');
        
        // 获取麦克风音频流，并应用音频处理约束
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true, // 开启回声消除
                noiseSuppression: true, // 开启噪声抑制
                channelCount: 1,  // 请求单声道
                sampleRate: 16000 // 请求16kHz采样率，这是语音识别常用标准
            } 
        });

        // 创建音频上下文
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        // 创建分析器节点，用于音量检测和可视化
        state.analyser = state.audioContext.createAnalyser();
        // 创建媒体流源节点
        const source = state.audioContext.createMediaStreamSource(stream);
        // 将音频源连接到分析器
        source.connect(state.analyser);

        // 初始化自定义的音频缓冲区
        state.audioBuffer = new AudioBuffer();
        state.audioBuffer.initialize(state.audioContext, stream);

        // 配置分析器参数
        state.analyser.fftSize = 256; // FFT窗口大小，影响频率分辨率
        state.analyser.smoothingTimeConstant = 0.8; // 平滑系数，使音量变化更平滑

        // 检查浏览器支持的MIME类型，优先使用opus编码
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/mpeg', // 新增MP3格式（移动端兼容性更好）
            'audio/3gpp', // 新增3GP格式（适配低版本安卓）
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

        // 使用找到的最佳MIME类型创建MediaRecorder实例
        if (selectedMimeType) {
            state.mediaRecorder = new MediaRecorder(stream, {
                mimeType: selectedMimeType
            });
        } else {
            // 如果没有找到，使用浏览器默认设置
            state.mediaRecorder = new MediaRecorder(stream);
        }

        console.log('使用音频格式:', selectedMimeType || 'default');

        // 设置MediaRecorder的事件监听
        setupMediaRecorder();
        // 开始连续监听模式
        startContinuousMonitoring();

        updateStatus('连续监听中...', 'listening');
        console.log('音频初始化成功，开始连续监听');
    } catch (error) {
        console.error('音频初始化失败:', error);
        showError('音频设备初始化失败: ' + error.message);
    }
}

/**
 * 设置MediaRecorder的事件处理器
 */
function setupMediaRecorder() {
    let audioChunks = []; // 用于收集录音数据块

    // 当有可用的音频数据时触发
    state.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            audioChunks.push(event.data);
        }
    };

    // 当录音停止时触发
    state.mediaRecorder.onstop = async () => {
        if (audioChunks.length > 0) {
            // 将收集到的数据块合并成一个Blob对象
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            audioChunks = []; // 清空数据块数组以备下次使用
            // 将音频Blob交给处理函数
            await processAudio(audioBlob);
        }
    };

    // 当录音发生错误时触发
    state.mediaRecorder.onerror = (error) => {
        console.error('录音错误:', error);
        showError('录音失败: ' + error.error);
        stopRecording(); // 停止录音
    };
}

/**
 * 启动连续监听模式
 */
function startContinuousMonitoring() {
    // 如果没有麦克风权限或已经在监听，则直接返回
    if (!state.micPermissionGranted || state.continuousMonitoring) return;

    state.continuousMonitoring = true;
    state.isListening = true;
    updateStatus('连续监听中...', 'listening');
    updateToggleButton(true);
    
    // 启动音频可视化效果
    startAudioVisualization();
    
    // 启动核心的声音活动检测循环
    startVoiceDetection();

    console.log('开始连续声音监听');
}

/**
 * 停止连续监听模式
 */
function stopContinuousMonitoring() {
    state.continuousMonitoring = false;
    state.isListening = false;
    updateStatus('已停止监听', 'stopped');
    updateToggleButton(false);
    
    // 停止音频可视化
    stopAudioVisualization();
    
    // 清理相关的定时器
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

/**
 * 切换监听状态
 * @description 这个函数暴露到全局作用域，由HTML中的按钮点击调用
 */
window.toggleListening = function() {
    if (state.continuousMonitoring) {
        stopContinuousMonitoring();
    } else {
        startContinuousMonitoring();
    }
};

/**
 * 执行全局中断
 * @description 这是一个核心功能，用于在用户说话时立即停止当前所有活动（如TTS播放、等待API响应）。
 */
function executeGlobalInterrupt() {
    console.log('🚨 执行全局中断...');
    
    // 设置中断状态标志
    state.isInterrupted = true;
    state.shouldInterrupt = false; // shouldInterrupt是一个意图，执行后就重置
    
    // 1. 中断正在进行的流式响应读取
    if (state.currentStreamReader) {
        try {
            console.log('中断流式响应读取...');
            state.currentStreamReader.cancel(); // 取消fetch的reader
            state.currentStreamReader = null;
        } catch (error) {
            console.warn('中断流式读取失败:', error);
        }
    }
    
    // 2. 停止正在播放的TTS
    if (state.ttsService && state.ttsService.isSpeaking()) {
        console.log('停止TTS播放...');
        state.ttsService.stop();
    }
    
    // 3. 重置处理中状态
    state.isProcessing = false;
    elements.statusPanel.classList.remove('processing', 'active');
    
    // 4. 更新UI状态，告知用户已中断
    updateStatus('ℹ️ 已中断当前回答，连续监听中...', 'listening');
    
    // 5. 延迟一小段时间后重置中断标志，并检查是否需要立即开始新的录音
    setTimeout(() => {
        state.isInterrupted = false;  // 重置中断标志
        // 如果此时用户仍在说话，则无缝开始下一次录音
        if (state.lastVolume > CONFIG.VOICE_DETECTION_THRESHOLD && !state.isRecording) {
            console.log('中断后检测到持续声音，开始新录音...');
            startRecording();
        }
    }, 100);
    
    console.log('✅ 全局中断完成');
}

/**
 * 手动触发中断
 * @description 这个函数暴露到全局作用域，由HTML中的按钮或键盘快捷键调用
 */
window.interruptTTS = function() {
    // 只有在正在处理或正在说话时才响应中断
    if (state.isProcessing || (state.ttsService && state.ttsService.isSpeaking())) {
        state.shouldInterrupt = true; // 设置中断意图
        executeGlobalInterrupt(); // 立即执行中断
        console.log('手动触发中断');
    }
};

/**
 * 清空对话记录
 * @description 这个函数暴露到全局作用域，由HTML中的按钮调用
 */
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
    // 清空对话ID，开始新的会话
    state.conversationId = '';
};

/**
 * 连续声音活动检测的核心循环 (优化版)
 * @description 这是语音助手的“耳朵”。它不断分析麦克风输入音量，
 *              以决定何时开始录音、何时停止录音，以及何时中断助手的讲话。
 */
function startVoiceDetection() {
    if (!state.continuousMonitoring || !state.analyser) return;
    
    let consecutiveVoiceFrames = 0; // 连续检测到声音的帧数
    let consecutiveSilenceFrames = 0; // 连续检测到静音的帧数
    const VOICE_CONFIRM_FRAMES = 3; // 需要连续多少帧有声音才确认用户开始说话
    const SILENCE_CONFIRM_FRAMES = Math.ceil(CONFIG.QUESTION_DELAY / CONFIG.VOICE_DETECTION_INTERVAL); // 对应2秒静音的帧数
    
    const checkVoiceLevel = () => {
        if (!state.continuousMonitoring) return; // 如果监听停止，则退出循环
        
        // 从AnalyserNode获取频率数据来计算当前音量
        const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
        state.analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        const volume = average / 255; // 归一化到0-1范围
        
        // 检查是否需要执行中断
        if (state.shouldInterrupt && (state.isProcessing || (state.ttsService && state.ttsService.isSpeaking()))) {
            console.log('🚨 执行全局中断...', {
                shouldInterrupt: state.shouldInterrupt,
                isProcessing: state.isProcessing,
                isTTSSpeaking: state.ttsService ? state.ttsService.isSpeaking() : false
            });
            
            // 执行全局中断
            executeGlobalInterrupt();
        }
        
        // --- 声音检测逻辑 ---
        if (volume > CONFIG.VOICE_DETECTION_THRESHOLD) {
            // 检测到声音
            consecutiveVoiceFrames++;
            consecutiveSilenceFrames = 0; // 重置静音帧计数
            
            // 当第一次检测到声音时
            if (consecutiveVoiceFrames === 1) {
                if (!state.voiceStartTime) {
                    state.voiceStartTime = Date.now(); // 记录声音开始的时间戳，用于预缓冲
                    console.log('检测到声音开始...');
                }
                
                // 如果此时助手正在说话或处理，设置中断意图
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
            
            // 当连续检测到足够的声音帧，且当前未在录音或处理中，则开始录音
            if (consecutiveVoiceFrames >= VOICE_CONFIRM_FRAMES && !state.isRecording && !state.isProcessing) {
                console.log('确认声音输入，开始录音');
                // 如果TTS正在播放，先停止它，以优先响应用户
                if (state.ttsService && state.ttsService.isSpeaking()) {
                    state.ttsService.stop();
                    console.log('停止TTS播放以开始录音');
                }
                startRecording();
            }
            
            state.lastVoiceTime = Date.now(); // 更新最后一次检测到声音的时间
        } else {
            // 未检测到声音（静音）
            consecutiveSilenceFrames++;
            consecutiveVoiceFrames = 0; // 重置声音帧计数
            
            // 如果之前检测到了声音但现在静音了（且还未开始录音），重置开始时间
            if (state.voiceStartTime && !state.isRecording) {
                state.voiceStartTime = null;
            }
            
            // 如果正在录音中，并且连续静音时间达到了阈值，则停止录音
            if (state.isRecording && consecutiveSilenceFrames >= SILENCE_CONFIRM_FRAMES) {
                console.log('2秒无声确认，停止录音');
                stopRecording();
                consecutiveSilenceFrames = 0; // 重置计数
            }
        }
        
        state.lastVolume = volume; // 保存当前音量值
        
        // 随机输出调试信息，避免刷屏
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
        
        // 使用setTimeout进行下一次检测，形成循环
        setTimeout(checkVoiceLevel, CONFIG.VOICE_DETECTION_INTERVAL);
    };
    
    // 启动检测循环
    checkVoiceLevel();
}

/**
 * 当检测到语音时调用的函数 (目前未使用，逻辑合并到 startVoiceDetection 中)
 */
function onVoiceDetected() {
    console.log('检测到语音输入');
    updateStatus('检测到语音，开始录音...', 'recording');
    
    // 可选：播放提示音
    // playNotificationSound();
}

/**
 * 播放一个提示音效
 * @description 使用Web Audio API动态生成一个简单的哔声。
 */
function playNotificationSound() {
    if (state.audioContext) {
        const oscillator = state.audioContext.createOscillator(); // 创建振荡器
        const gainNode = state.audioContext.createGain(); // 创建增益节点
        
        oscillator.connect(gainNode);
        gainNode.connect(state.audioContext.destination);
        
        // 设置频率和音量变化
        oscillator.frequency.setValueAtTime(800, state.audioContext.currentTime);
        oscillator.frequency.setValueAtTime(1000, state.audioContext.currentTime + 0.1);
        
        gainNode.gain.setValueAtTime(0.1, state.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, state.audioContext.currentTime + 0.2);
        
        oscillator.start(state.audioContext.currentTime);
        oscillator.stop(state.audioContext.currentTime + 0.2);
    }
}

/**
 * 开始录音 (优化版)
 * @description 启动MediaRecorder，并包含从AudioBuffer获取的预录制音频。
 */
function startRecording() {
    if (state.isRecording || !state.mediaRecorder) return;

    try {
        // 从音频缓冲区获取用户开始说话前的音频数据
        let bufferedData = [];
        if (state.audioBuffer && state.voiceStartTime) {
            // 这里的startRecording是AudioBuffer类的方法
            bufferedData = state.audioBuffer.startRecording(state.voiceStartTime);
            console.log(`从缓冲获取了 ${bufferedData.length} 帧音频数据`);
        }
        
        state.isRecording = true;
        // 开始录音，参数100表示每100ms触发一次ondataavailable事件
        state.mediaRecorder.start(100); 
        
        updateStatus('正在录音...', 'recording');
        elements.statusPanel.classList.remove('wakened');
        elements.statusPanel.classList.add('active');

        // 设置一个最大录音时长的超时，防止意外情况导致录音无法停止
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

/**
 * 停止录音 (优化版)
 */
function stopRecording() {
    if (!state.isRecording) return;

    state.isRecording = false;
    
    try {
        // 停止AudioBuffer的录音状态
        let allBufferedData = [];
        if (state.audioBuffer) {
            allBufferedData = state.audioBuffer.stopRecording();
        }
        
        // 停止MediaRecorder，这将触发onstop事件
        state.mediaRecorder.stop();
        updateStatus('录音结束，正在处理...', 'processing');
        elements.statusPanel.classList.remove('active');
        elements.statusPanel.classList.add('processing');

        // 清理录音超时定时器
        if (state.recordingTimer) {
            clearTimeout(state.recordingTimer);
            state.recordingTimer = null;
        }
        
        // 重置声音开始时间
        state.voiceStartTime = null;

        console.log(`停止录音，共获取 ${allBufferedData.length} 帧缓冲数据`);
    } catch (error) {
        console.error('停止录音失败:', error);
        state.voiceStartTime = null;
    }
}

/**
 * 静默检测 (旧版，逻辑已合并到 startVoiceDetection 中)
 * @description 这个函数通过requestAnimationFrame循环检测音量，
 *              如果连续一段时间低于阈值，则停止录音。
 *              当前版本中，此逻辑已整合到startVoiceDetection的setTimeout循环中。
 */
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

/**
 * 停止静默检测 (旧版)
 */
function stopSilenceDetection() {
    if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = null;
    }
}

/**
 * 处理录制的音频
 * @param {Blob} audioBlob - 录音完成后生成的音频Blob对象
 * @description 流程: STT API -> Chat API -> TTS
 */
async function processAudio(audioBlob) {
    try {
        state.isProcessing = true;
        updateStatus('正在识别语音...', 'processing');
        
        // 在发送到API前检查是否已被中断
        if (state.isInterrupted || state.shouldInterrupt) {
            console.log('🚨 音频处理被中断');
            return;
        }

        // 1. 调用语音转文本(STT) API
        const transcript = await callSTTAPI(audioBlob);
        
        if (transcript.trim()) {
            // 在STT成功后，再次检查中断状态
            if (state.isInterrupted || state.shouldInterrupt) {
                console.log('🚨 在STT完成后被中断');
                return;
            }
            
            // 将用户的识别结果显示在对话框中
            addMessage(transcript, 'user');
            
            // 2. 调用对话(Chat) API
            if (!state.isInterrupted && !state.shouldInterrupt) {
                await callChatAPI(transcript);
            } else {
                console.log('🚨 在调用对话API前被中断');
            }
        } else {
            // 如果STT没有返回任何文本
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
        
        // 如果在处理过程中被中断，则执行中断恢复逻辑
        if (state.isInterrupted || state.shouldInterrupt) {
            console.log('🔄 音频处理被中断，恢复监听状态');
            executeGlobalInterrupt();
        } else if (state.continuousMonitoring) {
            // 正常处理完成后，如果处于连续监听模式，则恢复监听状态
            setTimeout(() => {
                if (!state.isInterrupted && !state.shouldInterrupt) {
                    updateStatus('连续监听中...', 'listening');
                }
            }, 1000);
        }
    }
}

/**
 * 调用后端的语音转文本(STT) API
 * @param {Blob} audioBlob - 音频数据
 * @returns {Promise<string>} - 识别出的文本
 */
async function callSTTAPI(audioBlob) {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'audio.webm');
    formData.append('language', 'auto'); // 自动语言检测

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

/**
 * 调用后端的对话(Chat) API
 * @param {string} query - 用户的提问文本
 */
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
                conversation_id: state.conversationId, // 传递对话ID以保持上下文
            }),
        });

        if (!response.ok) {
            throw new Error(`对话API错误: ${response.status} ${response.statusText}`);
        }

        // API返回的是流式响应，需要专门处理
        await handleStreamResponse(response);

    } catch (error) {
        console.error('对话API调用失败:', error);
        showError('对话失败: ' + error.message);
        addMessage('抱歉，我现在无法回应，请稍后再试。', 'assistant');
    }
}

/**
 * 处理来自Chat API的流式响应
 * @param {Response} response - fetch API返回的Response对象
 * @description 后端使用Server-Sent Events (SSE)协议，前端需要逐块解析并更新UI。
 */
async function handleStreamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let completeAnswer = ''; // 拼接完整的回答文本
    let messageElement = null; // 对话框中对应消息的DOM元素引用
    
    // 保存reader的引用，以便在其他地方可以调用reader.cancel()来中断
    state.currentStreamReader = reader;

    try {
        while (true) {
            // 在读取每个数据块之前，检查是否需要中断（但不阻止完整回答的接收）
            if (state.isInterrupted || state.shouldInterrupt) {
                console.log('🚨 检测到中断标志，但继续接收完整回答');
                // 不再直接break，让回答完整接收后再处理中断
            }
            
            const { done, value } = await reader.read();
            if (done) break; // 流结束

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) { // SSE数据以"data: "开头
                    try {
                        const data = JSON.parse(line.slice(6)); // 解析JSON数据
                        
                        if (data.event === 'workflow_started') {
                            // 工作流开始事件，通常包含对话ID
                            state.conversationId = data.conversation_id || state.conversationId;
                            // 创建一个新的空消息框用于显示即将到来的回答
                            messageElement = addMessage('', 'assistant');
                        } else if (data.event === 'message') {
                            // 消息事件，包含部分回答
                            completeAnswer = data.complete_answer || '';
                            if (messageElement) {
                                // 实时更新消息框内容
                                updateMessageContent(messageElement, completeAnswer);
                            }
                        } else if (data.event === 'workflow_finished') {
                            // 工作流结束事件，包含最终的完整回答
                            const finalAnswer = data.final_answer || completeAnswer;
                            if (messageElement) {
                                // 更新消息内容
                                updateMessageContent(messageElement, finalAnswer);
                                
                                // 【强制TTS播放】无条件播放TTS，移除所有跳过逻辑
                                if (finalAnswer.trim() && state.ttsService) {
                                    // 强制重置所有中断标志
                                    state.isInterrupted = false;
                                    state.shouldInterrupt = false;
                                    
                                    // 强制启用TTS（防止被意外禁用）
                                    state.ttsService.setEnabled(true);
                                    
                                    console.log('🔊 强制开始TTS播放', {
                                        answer: finalAnswer.substring(0, 50) + '...',
                                        answerLength: finalAnswer.length
                                    });
                                    
                                    try {
                                        await state.ttsService.speak(finalAnswer);
                                        console.log('✅ TTS播放完成');
                                    } catch (error) {
                                        console.error('❌ TTS播放失败，但这不应该发生:', error);
                                        // 即使出错也要恢复监听状态
                                        if (state.continuousMonitoring) {
                                            updateStatus('连续监听中...', 'listening');
                                        }
                                    }
                                } else {
                                    // 只有在没有回答内容或TTS服务不存在时才跳过
                                    console.warn('⚠️ 无法播放TTS:', {
                                        hasAnswer: !!finalAnswer.trim(),
                                        hasTTSService: !!state.ttsService,
                                        answer: finalAnswer
                                    });
                                    
                                    if (state.continuousMonitoring) {
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
        // 清理工作
        state.currentStreamReader = null; // 清除reader引用
        try {
            reader.releaseLock(); // 释放reader的锁
        } catch (e) {
            // 忽略锁释放错误
        }
    }
}

/**
 * 向对话界面添加一条新消息
 * @param {string} content - 消息内容 (可以是HTML)
 * @param {'user' | 'assistant'} type - 消息类型
 * @returns {HTMLElement} - 创建的消息DOM元素
 */
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
    // 自动滚动到底部
    elements.conversation.scrollTop = elements.conversation.scrollHeight;

    return messageDiv;
}

/**
 * 更新已存在消息的内容
 * @param {HTMLElement} messageElement - addMessage返回的DOM元素
 * @param {string} content - 新的内容
 */
function updateMessageContent(messageElement, content) {
    const contentElement = messageElement.querySelector('.message-content');
    if (contentElement) {
        contentElement.textContent = content; // 使用textContent以避免XSS风险
    }
}

/**
 * 启动音频可视化
 * @description 使用requestAnimationFrame循环从AnalyserNode获取数据并绘制到Canvas上。
 */
function startAudioVisualization() {
    if (!state.analyser) return;

    const canvas = elements.visualizerCanvas;
    const ctx = canvas.getContext('2d');
    elements.visualizerPlaceholder.style.display = 'none';
    canvas.style.display = 'block';

    const animate = () => {
        // 如果监听和录音都停止了，则停止动画
        if (!state.continuousMonitoring && !state.isRecording) {
            canvas.style.display = 'none';
            elements.visualizerPlaceholder.style.display = 'flex';
            return;
        }

        // 获取频率数据
        const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
        state.analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';

        const barWidth = canvas.width / dataArray.length;
        let x = 0;

        // 遍历数据并绘制柱状图
        for (let i = 0; i < dataArray.length; i++) {
            const barHeight = (dataArray[i] / 255) * canvas.height * 0.8;
            ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
            x += barWidth;
        }

        // 请求下一帧动画
        state.animationId = requestAnimationFrame(animate);
    };

    animate();
}

/**
 * 停止音频可视化
 */
function stopAudioVisualization() {
    if (state.animationId) {
        cancelAnimationFrame(state.animationId);
        state.animationId = null;
    }
}

/**
 * 更新UI上的状态显示
 * @param {string} text - 主要状态文本
 * @param {'loading'|'ready'|'listening'|'recording'|'processing'|'speaking'|'stopped'} status - 状态类型，用于控制CSS样式
 */
function updateStatus(text, status) {
    elements.statusText.textContent = text;
    
    // 更新状态点的颜色
    elements.statusDot.className = 'status-dot';
    if (status) {
        elements.statusDot.classList.add(status);
    }

    // 定义不同状态的详细描述文本
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


/**
 * 更新切换监听按钮的文本和图标
 * @param {boolean} isListening - 当前是否在监听
 */
function updateToggleButton(isListening) {
    elements.toggleIcon.textContent = isListening ? '⏸️' : '▶️';
    elements.toggleText.textContent = isListening ? '暂停监听' : '开始监听';
    // 在处理请求时禁用按钮，防止冲突
    elements.toggleBtn.disabled = state.isProcessing;
}

/**
 * 显示请求麦克风权限的提示浮层
 */
function showPermissionPrompt() {
    elements.permissionPrompt.classList.add('show');
}

/**
 * 隐藏请求麦克风权限的提示浮层
 */
function hidePermissionPrompt() {
    elements.permissionPrompt.classList.remove('show');
}

/**
 * 在页面顶部显示一条错误信息
 * @param {string} message - 要显示的错误消息
 */
function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.classList.add('show');
    
    // 5秒后自动隐藏
    setTimeout(() => {
        elements.errorMessage.classList.remove('show');
    }, 5000);
}

// --- 全局事件监听器 ---

// 捕获全局未处理的错误
window.addEventListener('error', (event) => {
    console.error('全局错误:', event.error);
    showError('系统错误: ' + event.error.message);
});

// 捕获未处理的Promise拒绝（通常是网络请求失败）
window.addEventListener('unhandledrejection', (event) => {
    console.error('未处理的Promise拒绝:', event.reason);
    showError('网络或服务错误，请检查连接');
});

// 页面关闭或刷新前，清理资源
window.addEventListener('beforeunload', () => {
    // 确保停止录音
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
    }
    // 关闭音频上下文
    if (state.audioContext) {
        state.audioContext.close();
    }
    // 销毁音频缓冲区
    if (state.audioBuffer) {
        state.audioBuffer.destroy();
    }
    // 销毁TTS服务
    if (state.ttsService) {
        state.ttsService.destroy();
    }
    // 清理所有定时器
    if (state.voiceDetectionTimer) {
        clearTimeout(state.voiceDetectionTimer);
    }
    if (state.questionTimer) {
        clearTimeout(state.questionTimer);
    }
});

// 添加全局键盘快捷键支持
document.addEventListener('keydown', (event) => {
    // 按下 ESC 键：中断TTS播放
    if (event.key === 'Escape') {
        if (state.ttsService && state.ttsService.isSpeaking()) {
            window.interruptTTS();
            event.preventDefault(); // 阻止默认行为
        }
    }
    // 按下 空格键：切换监听状态 (当焦点不在输入框时)
    if (event.key === ' ' && event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA') {
        window.toggleListening();
        event.preventDefault(); // 阻止页面滚动
    }
});

console.log('小普同学语音助手已加载');
console.log('快捷键说明: ESC中断播放, 空格切换监听');


// --- 全局调试和控制函数 (暴露给window) ---

/**
 * 切换TTS功能的启用/禁用
 */
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

/**
 * 切换音频文件保存功能
 */
window.toggleSaveAudio = function() {
    if (state.ttsService) {
        const newState = !state.ttsService.config.saveAudioFiles;
        state.ttsService.setSaveAudioFiles(newState);
        
        // 显示状态变化
        const statusText = newState ? '音频文件保存已启用' : '音频文件保存已禁用';
        showError(statusText, false);
    }
};

/**
 * 强制停止TTS播放
 */
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

/**
 * 动态设置TTS的语音模型
 * @param {string} voice - 新的语音模型标识符
 */
window.setTTSVoice = function(voice) {
    if (state.ttsService) {
        state.ttsService.setConfig({ voice: voice });
        console.log('TTS语音已设置为:', voice);
    }
};

/**
 * 测试TTS中断功能
 */
window.testTTSInterrupt = function() {
    if (state.ttsService) {
        console.log('🎤 开始测试TTS中断功能...');
        // 播放一段长文本，并提示用户可以说话来中断
        state.ttsService.speak('这是一段测试语音，你可以通过说话来中断我。现在请尝试说话来测试中断功能。说话阈值设置为' + CONFIG.VOICE_DETECTION_THRESHOLD)
            .then(() => {
                console.log('✅ 测试TTS播放完成（未被中断）');
            })
            .catch((error) => {
                console.log('❌ 测试TTS被中断或出错:', error);
            });
    } else {
        console.log('❌ TTS服务未初始化');
    }
};

/**
 * 在控制台打印当前系统的详细状态，用于调试
 */
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
