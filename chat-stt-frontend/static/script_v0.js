
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

// API基础URL - 根据后端配置调整
let API_BASE;

// 同步初始化配置
function initConfigSync() {
    const configMap = loadYamlToMapSync();
    
    API_BASE = configMap.get('API_BASE');
}

initConfigSync()

console.log('1',API_BASE)

// 全局变量
let conversationId = '';
let isLoading = false;
let messageCount = 1; // 初始欢迎消息

// 语音录制变量
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let silenceTimer = null;
let audioContext = null;
let analyser = null;
let silenceThreshold = 30;
let silenceTimeout = 2000;

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
    
    // 检查必要元素是否存在
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
            // Shift+Enter换行，自动调整高度
            setTimeout(() => autoResizeTextarea(input), 0);
        }
    });

    input.addEventListener('input', () => autoResizeTextarea(input));
    
    // 设置初始时间戳 - 添加元素存在检查
    const timestampElement = document.querySelector('.timestamp');
    if (timestampElement) {
        timestampElement.textContent = formatTime(new Date());
    }
    
    // 检查语音支持
    checkAudioSupport();
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
        
        // 检查浏览器是否支持MediaRecorder
        if (!window.MediaRecorder) {
            throw new Error('浏览器不支持MediaRecorder API');
        }
        
        updateStatus('语音功能已就绪');
        setTimeout(() => updateStatus(''), 2000);
    } catch (error) {
        console.error('音频支持检查失败:', error);
        updateStatus('⚠️ 语音功能不可用: ' + error.message);
        
        // 隐藏语音按钮而不是移除display
        const voiceButton = document.getElementById('voiceButton');
        if (voiceButton) {
            voiceButton.style.visibility = 'hidden';
        }
    }
}

// 语音录制功能
async function startRecording() {
    try {
        // 清理之前的录制状态
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
        
        // 检查支持的MIME类型
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
        
        // 音频分析器 - 添加错误处理
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(stream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
        } catch (audioError) {
            console.warn('音频分析器初始化失败:', audioError);
            // 不阻断录音功能，只是没有静音检测
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
    if (isLoading) {
        updateStatus('请等待当前操作完成');
        return;
    }
    
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

// 静音检测
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

// 处理录音音频
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
            
            // 检查音频文件大小
            if (audioBlob.size === 0) {
                throw new Error('音频文件为空');
            }
            
            if (audioBlob.size > 25 * 1024 * 1024) { // 25MB限制
                throw new Error('音频文件过大，请录制较短的语音');
            }
            
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');
            formData.append('language', 'auto');

            // 添加超时控制
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时

            // 发送到后端的语音转文字接口
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
                    
                    // 自动发送消息
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
            
            // 网络错误重试
            if (retryCount < maxRetries && (
                error.message.includes('Failed to fetch') || 
                error.message.includes('Network') ||
                error.message.includes('timeout')
            )) {
                retryCount++;
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // 递增延迟
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
        if (voiceHint) {
            voiceHint.classList.add('show');
            voiceHint.textContent = '正在录音，2秒静音后自动发送...';
        }
    } else if (processing) {
        voiceButton.className = 'voice-button processing';
        if (voiceIcon) {
            voiceIcon.innerHTML = '<div class="loading-spinner"></div>';
        }
        if (voiceHint) {
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

// 发送消息功能
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    
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
    
    // 显示AI思考状态
    showTypingIndicator();
    
    let retryCount = 0;
    const maxRetries = 2;
    
    async function attemptSendMessage() {
        try {
            // 添加超时控制
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000); // 60秒超时
            
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
            
            // 网络错误重试逻辑
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
            
            // 添加错误消息
            addMessage(`❌ 发送失败: ${error.message}`, false);
            updateStatus('消息发送失败');
        }
    }
    
    try {
        await attemptSendMessage();
    } finally {
        setInputsEnabled(true);
        isLoading = false;
        if (input) {
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
        } else {
            contentDiv.innerHTML = renderedContent;
        }
    } catch (error) {
        console.error('更新消息内容失败:', error);
        contentDiv.textContent = content; // 降级到纯文本
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
        /^#{1,6}\s/,         // 标题
        /^>\s/,              // 引用
        /^[*-]\s/,           // 列表
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
    
    messagesContainer.appendChild(messageDiv);
    
    // 自动滚动到底部
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    return messageDiv;
}

// 显示AI正在输入的指示器
function showTypingIndicator() {
    const messagesContainer = document.getElementById('chatMessages');
    if (!messagesContainer) return;
    
    // 移除已有的输入指示器
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
    
    if (input) {
        input.disabled = !enabled;
    }
    
    if (sendButton) {
        sendButton.disabled = !enabled;
        sendButton.innerHTML = enabled ? '➤' : '<div class="loading-spinner"></div>';
    }
    
    if (voiceButton) {
        voiceButton.disabled = !enabled;
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
function clearConversation() {
    if (!confirm('确定要清空所有对话记录吗？此操作不可撤销。')) {
        return;
    }
    
    try {
        // 停止任何正在进行的录音
        if (isRecording) {
            stopRecording();
        }
        
        // 清理音频资源
        if (audioContext && audioContext.state === 'running') {
            audioContext.close();
        }
        
        const messagesContainer = document.getElementById('chatMessages');
        if (messagesContainer) {
            messagesContainer.innerHTML = `
                <div class="message assistant">
                    <div class="message-content">
                        你好！我是AI智能助手，可以帮你解答问题、分析数据、生成图表等。你可以通过文字输入或语音输入与我交流。
                        <div class="timestamp">${formatTime(new Date())}</div>
                    </div>
                </div>
            `;
        }
        
        // 重置状态
        conversationId = '';
        messageCount = 1;
        isLoading = false;
        
        const conversationIdElement = document.getElementById('conversationId');
        if (conversationIdElement) {
            conversationIdElement.textContent = '等待开始';
        }
        
        updateMessageCount();
        updateStatus('对话已清空');
        setTimeout(() => updateStatus(''), 2000);
        
        // 重新启用输入控件
        setInputsEnabled(true);
        
    } catch (error) {
        console.error('清空对话失败:', error);
        updateStatus('清空对话时发生错误');
    }
}
