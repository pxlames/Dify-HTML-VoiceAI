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
        WAKE_WORDS: ['你好小普同学', '小普同学', '小普小普', '你可以听见我说话吗'],
        RECORDING_TIMEOUT: 10000, // 录音最大时长限制，10秒后无条件强制停止录音（防止录音无限持续）
        SILENCE_THRESHOLD: 0.01, //  volume 是一个在 0.0 (完全静音) 到 1.0 (最大音量) 之间的小数。
        SILENCE_DURATION: 2000,
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
    // 音频缓冲区相关
    continuousRecorder: null,
    audioBuffer: [],
    bufferStartTime: 0,
    isWakeWordDetecting: false,
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
                console.log('TTS开始播放:', text);
                updateStatus('小普正在说话...', 'speaking');
            },
            onEnd: () => {
                console.log('TTS播放完成');
                // 恢复监听状态
                if (state.isListening) {
                    updateStatus('监听中...', 'listening');
                    detectWakeWord(); // 继续监听
                } else {
                    updateStatus('准备就绪', 'ready');
                }
            },
            onError: (error) => {
                console.error('TTS播放错误:', error);
                showError('语音播放失败: ' + error.message);
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
        startListening();

        updateStatus('准备就绪', 'ready');
        console.log('音频初始化成功');
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

// 开始监听唤醒词
function startListening() {
    if (!state.micPermissionGranted || state.isListening) return;

    state.isListening = true;
    updateStatus('监听中...', 'listening');
    updateToggleButton(true);
    
    // 开始音频可视化
    startAudioVisualization();
    
    // 开始连续录音缓冲
    startContinuousRecording();
    
    // 监听唤醒词
    detectWakeWord();

    console.log('开始监听唤醒词');
}

// 停止监听
function stopListening() {
    state.isListening = false;
    updateStatus('已停止监听', 'stopped');
    updateToggleButton(false);
    
    // 停止音频可视化
    stopAudioVisualization();
    
    // 停止连续录音缓冲
    stopContinuousRecording();

    console.log('停止监听');
}

// 切换监听状态 (全局函数，供HTML调用)
window.toggleListening = function() {
    if (state.isListening) {
        stopListening();
    } else {
        startListening();
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
                对话已清空。请说"小普同学"来唤醒我，然后告诉我你需要什么帮助。
            </div>
            <div class="message-time">${new Date().toLocaleTimeString()}</div>
        </div>
    `;
    state.conversationId = '';
};

// 开始连续录音缓冲
function startContinuousRecording() {
    if (state.continuousRecorder || !state.isListening) return;
    
    navigator.mediaDevices.getUserMedia({ 
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
            sampleRate: 16000
        } 
    }).then(stream => {
        state.continuousRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus'
        });
        
        state.continuousRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                // 添加时间戳到音频块
                state.audioBuffer.push({
                    data: event.data,
                    timestamp: Date.now()
                });
                
                // 保持缓冲区在合理大小（只保留最近10秒的数据）
                const now = Date.now();
                state.audioBuffer = state.audioBuffer.filter(chunk => 
                    now - chunk.timestamp < 10000
                );
            }
        };
        
        state.continuousRecorder.onerror = (error) => {
            console.error('连续录音错误:', error);
        };
        
        // 开始连续录音，每100ms产生一个数据块
        state.continuousRecorder.start(100);
        console.log('开始连续录音缓冲');
        
    }).catch(error => {
        console.error('启动连续录音失败:', error);
    });
}

// 停止连续录音缓冲
function stopContinuousRecording() {
    if (state.continuousRecorder) {
        state.continuousRecorder.stop();
        state.continuousRecorder = null;
        state.audioBuffer = [];
        console.log('停止连续录音缓冲');
    }
}

// 从缓冲区获取最近N秒的音频
function getRecentAudio(seconds = 2) {
    const now = Date.now();
    const recentChunks = state.audioBuffer.filter(chunk => 
        now - chunk.timestamp < seconds * 1000
    );
    
    if (recentChunks.length === 0) return null;
    
    const audioBlobs = recentChunks.map(chunk => chunk.data);
    return new Blob(audioBlobs, { type: 'audio/webm' });
}

// 唤醒词检测 (使用STT接口)
function detectWakeWord() {
    // 如果不在监听状态或正在播放TTS，则不进行检测
    if (!state.isListening || (state.ttsService && state.ttsService.isSpeaking())) {
        // 如果在播放TTS，等待播放完成后再继续检测
        if (state.ttsService && state.ttsService.isSpeaking()) {
            setTimeout(detectWakeWord, 1000);
        }
        return;
    }
 
    // 检测音量阈值，避免在静音时检测
    if (state.analyser) {
        const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
        state.analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        const volume = average / 255;
        
        // 只有在有声音时才进行唤醒词检测
        if (volume > 0.1 && !state.isWakeWordDetecting) {
            state.isWakeWordDetecting = true;
            
            // 从缓冲区获取最近2秒的音频
            const recentAudio = getRecentAudio(2);
            
            if (recentAudio && recentAudio.size > 1000) {
                checkWakeWordInAudio(recentAudio).then(found => {
                    state.isWakeWordDetecting = false;
                    
                    if (found) {
                        // 找到唤醒词，停止连续录音，开始正式录音
                        stopContinuousRecording();
                        onWakeWordDetected();
                        return;
                    }
                    
                    // 没找到唤醒词，继续检测
                    setTimeout(detectWakeWord, 500);
                }).catch(error => {
                    state.isWakeWordDetecting = false;
                    console.error('唤醒词检测失败:', error);
                    setTimeout(detectWakeWord, 1000);
                });
                
                return;
            } else {
                state.isWakeWordDetecting = false;
            }
        }
    }
    
    // 继续监听
    setTimeout(detectWakeWord, 200);
}

// 检查音频中是否包含唤醒词
async function checkWakeWordInAudio(audioBlob) {
    try {
        // 调用STT API
        const formData = new FormData();
        formData.append('audio', audioBlob, 'wake_audio.webm');
        formData.append('language', 'zh');
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        
        const response = await fetch(`${CONFIG.API_BASE}/transcribe`, {
            method: 'POST',
            body: formData,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const result = await response.json();
            const transcript = result.text || '';
            
            if (transcript.trim()) {
                console.log('检测到语音:', transcript);
                
                // 检查是否包含唤醒词
                const normalizedText = transcript.toLowerCase().replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
                let wakeWordFound = false;
                
                // 检查配置的唤醒词
                for (const wakeWord of CONFIG.WAKE_WORDS) {
                    const normalizedWakeWord = wakeWord.toLowerCase().replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
                    if (normalizedText.includes(normalizedWakeWord)) {
                        wakeWordFound = true;
                        break;
                    }
                }
                
                // 模糊匹配 - 只匹配与"小普"相关的词汇
                if (!wakeWordFound) {
                    const fuzzyMatches = ['小普同学', '小普', '晓普', '小布同学', '小布', '晓布'];
                    for (const fuzzyWord of fuzzyMatches) {
                        if (normalizedText.includes(fuzzyWord)) {
                            wakeWordFound = true;
                            break;
                        }
                    }
                }
                
                if (wakeWordFound) {
                    console.log('检测到唤醒词:', transcript);
                    return true;
                } else {
                    console.log('非唤醒词，继续监听:', transcript);
                }
            }
        }
        
        return false;
        
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('唤醒词检测失败:', error);
        }
        return false;
    }
}

// 唤醒词被检测到
function onWakeWordDetected() {
    console.log('检测到唤醒词');
    updateStatus('小普被唤醒了！', 'wakened');
    elements.statusPanel.classList.add('wakened');
    
    // 播放提示音（可选）
    playNotificationSound();
    
    // 开始录音
    setTimeout(startRecording, 500);
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

// 开始录音
function startRecording() {
    if (state.isRecording || !state.mediaRecorder) return;

    try {
        state.isRecording = true;
        state.mediaRecorder.start();
        
        updateStatus('请说话...', 'recording');
        elements.statusPanel.classList.remove('wakened');
        elements.statusPanel.classList.add('active');

        // 设置录音超时
        state.recordingTimer = setTimeout(() => {
            if (state.isRecording) {
                stopRecording();
            }
        }, CONFIG.RECORDING_TIMEOUT);

        // 监听静默
        startSilenceDetection();

        console.log('开始录音');
    } catch (error) {
        console.error('录音启动失败:', error);
        showError('录音启动失败');
        state.isRecording = false;
    }
}

// 停止录音
function stopRecording() {
    if (!state.isRecording) return;

    state.isRecording = false;
    
    try {
        state.mediaRecorder.stop();
        updateStatus('录音结束，正在处理...', 'processing');
        elements.statusPanel.classList.remove('active');
        elements.statusPanel.classList.add('processing');

        // 清除定时器
        if (state.recordingTimer) {
            clearTimeout(state.recordingTimer);
            state.recordingTimer = null;
        }

        stopSilenceDetection();

        console.log('停止录音');
    } catch (error) {
        console.error('停止录音失败:', error);
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

        // 调用STT API
        const transcript = await callSTTAPI(audioBlob);
        
        if (transcript.trim()) {
            addMessage(transcript, 'user');
            
            // 调用对话API
            await callChatAPI(transcript);
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
        
        if (state.isListening) {
            setTimeout(() => {
                updateStatus('监听中...', 'listening');
                detectWakeWord(); // 继续监听
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

    try {
        while (true) {
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
                            const finalAnswer = data.final_answer || completeAnswer;
                            if (messageElement) {
                                // 更新消息内容
                                updateMessageContent(messageElement, finalAnswer);
                                
                                // 【核心修改】调用TTS播放语音
                                if (finalAnswer.trim() && state.ttsService) {
                                    try {
                                        await state.ttsService.speak(finalAnswer);
                                    } catch (error) {
                                        console.error('TTS播放失败:', error);
                                        // 即使TTS失败也要恢复监听状态
                                        if (state.isListening) {
                                            updateStatus('监听中...', 'listening');
                                            detectWakeWord();
                                        }
                                    }
                                } else {
                                    updateStatus('回答完成', 'ready');
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
        if (messageElement) {
            updateMessageContent(messageElement, '抱歉，回答被中断了。');
        }
    } finally {
        reader.releaseLock();
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
        if (!state.isListening && !state.isRecording) {
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
        ready: '说"小普同学"来唤醒我',
        listening: '正在监听唤醒词...',
        wakened: '开始说话吧！',
        recording: '录音中，请保持安静',
        processing: '正在处理您的请求...',
        speaking: '小普正在回复中...', // 新增TTS播放状态
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
// 修改页面卸载事件处理
window.addEventListener('beforeunload', () => {
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
    }
    if (state.audioContext) {
        state.audioContext.close();
    }
    // 清理TTS资源
    if (state.ttsService) {
        state.ttsService.destroy();
    }
});

console.log('小普同学语音助手已加载');


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