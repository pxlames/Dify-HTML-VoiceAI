/**
 * TTS 语音合成模块
 * 基于 SiliconFlow TTS API
 */
class TTSService {
  constructor(config = {}) {
      this.config = {
          apiToken: config.apiToken || '',
          apiUrl: 'https://api.siliconflow.cn/v1/audio/speech',
          model: 'fnlp/MOSS-TTSD-v0.5',
          voice: config.voice || 'female-1',
          enabled: config.enabled !== false, // 默认启用
          timeout: config.timeout || 30000, // 30秒超时
          speed: 2.5,
          ...config
      };
      
      this.state = {
          currentAudio: null,
          isSpeaking: false,
          audioQueue: [], // 音频播放队列
          isProcessing: false,
          audioUnlocked: false // 移动端音频解锁状态
      };

      this.callbacks = {
          onStart: null,
          onEnd: null,
          onError: null,
          onProgress: null
      };

      console.log('TTS服务初始化完成');
  }

  /**
   * 设置回调函数
   * @param {Object} callbacks 回调函数集合
   */
  setCallbacks(callbacks) {
      this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * 设置配置
   * @param {Object} config 配置对象
   */
  setConfig(config) {
      this.config = { ...this.config, ...config };
  }

  /**
   * 启用/禁用TTS
   * @param {boolean} enabled 是否启用
   */
  setEnabled(enabled) {
      this.config.enabled = enabled;
      if (!enabled && this.state.isSpeaking) {
          this.stop();
      }
  }

  /**
   * 检查是否正在播放
   * @returns {boolean}
   */
  isSpeaking() {
      return this.state.isSpeaking;
  }

  /**
   * 将文本转换为语音并播放
   * @param {string} text 要转换的文本
   * @param {Object} options 选项参数
   * @returns {Promise<void>}
   */
  async speak(text, options = {}) {
      if (!this.config.enabled) {
          console.log('TTS功能已禁用');
          return;
      }

      if (!text || !text.trim()) {
          console.warn('TTS: 文本内容为空');
          return;
      }

      if (!this.config.apiToken) {
          throw new Error('TTS API Token 未配置');
      }

      try {
          this.state.isProcessing = true;
          
          // 触发开始回调
          if (this.callbacks.onStart) {
              this.callbacks.onStart(text);
          }

          // 停止当前播放
          this.stop();

          // 调用TTS API获取音频
          const audioBlob = await this._callTTSAPI(text, options);
          
          // 播放音频
          await this._playAudio(audioBlob);

      } catch (error) {
          console.error('TTS播放失败:', error);
          if (this.callbacks.onError) {
              this.callbacks.onError(error);
          }
          throw error;
      } finally {
          this.state.isProcessing = false;
      }
  }

  /**
   * 添加文本到播放队列
   * @param {string} text 要播放的文本
   * @param {Object} options 选项参数
   */
  async enqueue(text, options = {}) {
      if (!this.config.enabled || !text?.trim()) return;

      this.state.audioQueue.push({ text, options });
      
      if (!this.state.isSpeaking && !this.state.isProcessing) {
          await this._processQueue();
      }
  }

  /**
   * 处理播放队列
   * @private
   */
  async _processQueue() {
      while (this.state.audioQueue.length > 0 && this.config.enabled) {
          const { text, options } = this.state.audioQueue.shift();
          try {
              await this.speak(text, options);
          } catch (error) {
              console.error('队列播放失败:', error);
          }
      }
  }

  /**
   * 停止当前播放
   */
  stop() {
      if (this.state.currentAudio) {
          this.state.currentAudio.pause();
          this.state.currentAudio.currentTime = 0;
          this.state.currentAudio = null;
      }
      this.state.isSpeaking = false;
      this.state.audioQueue = []; // 清空队列
  }

  /**
   * 暂停播放
   */
  pause() {
      if (this.state.currentAudio && !this.state.currentAudio.paused) {
          this.state.currentAudio.pause();
      }
  }

  /**
   * 恢复播放
   */
  resume() {
      if (this.state.currentAudio && this.state.currentAudio.paused) {
          this.state.currentAudio.play().catch(error => {
              console.error('恢复播放失败:', error);
          });
      }
  }

  /**
   * 调用TTS API
   * @param {string} text 文本内容
   * @param {Object} options 选项参数
   * @returns {Promise<Blob>} 音频Blob数据
   * @private
   */
  async _callTTSAPI(text, options = {}) {
      const requestBody = {
          model: options.model || this.config.model,
          input: text,
          voice: options.voice || this.config.voice,
          response_format: 'mp3'  // 强制使用MP3格式，iOS Safari兼容
      };

      console.log('TTS API请求 (强制MP3格式):', requestBody);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      try {
          const response = await fetch(this.config.apiUrl, {
              method: 'POST',
              headers: {
                  'Authorization': `Bearer ${this.config.apiToken}`,
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
              let errorMessage = `TTS API请求失败: ${response.status} ${response.statusText}`;
              try {
                  const errorData = await response.json();
                  errorMessage += ` - ${errorData.error || errorData.message || '未知错误'}`;
              } catch (e) {
                  // 忽略JSON解析错误
              }
              throw new Error(errorMessage);
          }

          const audioBlob = await response.blob();
          console.log(`TTS音频获取成功，大小: ${audioBlob.size} 字节`);
          
          return audioBlob;

      } catch (error) {
          clearTimeout(timeoutId);
          if (error.name === 'AbortError') {
              throw new Error('TTS请求超时');
          }
          throw error;
      }
  }

  /**
   * 播放音频
   * @param {Blob} audioBlob 音频数据
   * @returns {Promise<void>}
   * @private
   */
  async _playAudio(audioBlob) {
      return new Promise((resolve, reject) => {
          // 验证音频Blob
          if (!audioBlob || audioBlob.size === 0) {
              reject(new Error('音频数据无效或为空'));
              return;
          }
          
          console.log('音频Blob信息:', {
              size: audioBlob.size,
              type: audioBlob.type || '未设置MIME类型'
          });
          
          // 为iOS Safari创建正确的音频Blob
          let finalBlob = audioBlob;
          if (this._isIOSDevice()) {
              // iOS Safari需要正确的MIME类型
              if (!audioBlob.type || audioBlob.type === 'application/octet-stream') {
                  console.log('为iOS设备设置MP3 MIME类型');
                  finalBlob = new Blob([audioBlob], { type: 'audio/mpeg' });
              }
          }

          const audioUrl = URL.createObjectURL(finalBlob);
          const audio = new Audio(audioUrl);

          // 设置音频属性
          audio.volume = 1.0;
          audio.preload = 'auto';
          
          // iOS Safari特殊设置
          if (this._isIOSDevice()) {
              audio.setAttribute('playsinline', true);
              audio.setAttribute('webkit-playsinline', true);
              audio.crossOrigin = 'anonymous';
              audio.preload = 'metadata'; // iOS上更稳定
          }

          // 播放完成事件
          audio.onended = () => {
              this.state.isSpeaking = false;
              this.state.currentAudio = null;
              URL.revokeObjectURL(audioUrl);
              
              if (this.callbacks.onEnd) {
                  this.callbacks.onEnd();
              }
              
              resolve();
          };

          // 错误处理
          audio.onerror = (error) => {
              this.state.isSpeaking = false;
              this.state.currentAudio = null;
              URL.revokeObjectURL(audioUrl);
              
              // 获取详细错误信息
              let errorDetail = '未知错误';
              if (error && error.target && error.target.error) {
                  const mediaError = error.target.error;
                  switch (mediaError.code) {
                      case 1: errorDetail = 'MEDIA_ERR_ABORTED - 播放被中止'; break;
                      case 2: errorDetail = 'MEDIA_ERR_NETWORK - 网络错误'; break;
                      case 3: errorDetail = 'MEDIA_ERR_DECODE - 解码失败'; break;
                      case 4: errorDetail = 'MEDIA_ERR_SRC_NOT_SUPPORTED - 音频格式不支持'; break;
                      default: errorDetail = `媒体错误代码: ${mediaError.code}`;
                  }
              }
              
              let errorMsg = `音频播放失败: ${errorDetail}`;
              
              // iOS特殊错误提示
              if (this._isIOSDevice()) {
                  errorMsg += ' (iOS Safari)';
                  if (errorDetail.includes('不支持') || errorDetail.includes('解码失败')) {
                      errorMsg += ' - 已强制使用MP3格式，如仍有问题请检查网络连接';
                  }
                  if (!this.state.audioUnlocked) {
                      errorMsg += ' - 请点击页面任意位置解锁音频播放';
                  }
              }
              
              console.error('iOS音频播放错误:', errorDetail, error);
              
              if (this.callbacks.onError) {
                  this.callbacks.onError(new Error(errorMsg));
              }
              
              reject(new Error(errorMsg));
          };

          // 播放进度事件
          audio.ontimeupdate = () => {
              if (this.callbacks.onProgress) {
                  this.callbacks.onProgress({
                      currentTime: audio.currentTime,
                      duration: audio.duration,
                      progress: audio.duration ? audio.currentTime / audio.duration : 0
                  });
              }
          };

          // 音频加载完成
          audio.oncanplaythrough = () => {
              console.log('音频加载完成，开始播放');
          };

          // 开始播放
          this.state.currentAudio = audio;
          this.state.isSpeaking = true;

          const playPromise = audio.play();
          if (playPromise !== undefined) {
              playPromise.catch(error => {
                  this.state.isSpeaking = false;
                  this.state.currentAudio = null;
                  URL.revokeObjectURL(audioUrl);
                  
                  let errorMessage = `音频播放启动失败: ${error.message}`;
                  
                  // iOS Safari特殊错误处理
                  if (this._isIOSDevice()) {
                      console.error('iOS播放失败:', error.name, error.message);
                      
                      if (error.name === 'NotAllowedError') {
                          errorMessage += ' - iOS Safari阻止了音频播放，请点击页面任意位置后重试';
                      } else if (error.name === 'NotSupportedError') {
                          errorMessage += ' - iOS Safari不支持此音频，已使用MP3格式但仍失败';
                      } else if (error.name === 'AbortError') {
                          errorMessage += ' - 播放被中止';
                      }
                  }
                  
                  reject(new Error(errorMessage));
              });
          }
      });
  }

  /**
   * 解锁移动端音频播放（需要在用户交互时调用）
   * @description 移动端浏览器需要用户交互才能播放音频，此方法应在首次用户交互时调用
   */
  unlockAudio() {
      if (this.state.audioUnlocked) {
          console.log('音频已解锁');
          return;
      }
      
      try {
          // 创建一个静音的短音频来解锁音频播放权限
          const silentAudio = new Audio();
          silentAudio.volume = 0;
          silentAudio.preload = 'auto';
          
          // 创建一个极短的静音音频数据
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const buffer = audioContext.createBuffer(1, 1, 22050);
          const source = audioContext.createBufferSource();
          source.buffer = buffer;
          
          // 播放静音音频来解锁
          const promise = silentAudio.play();
          if (promise) {
              promise.then(() => {
                  this.state.audioUnlocked = true;
                  console.log('移动端音频播放权限已解锁');
              }).catch(error => {
                  console.warn('音频解锁失败，但这通常不影响后续播放:', error);
                  this.state.audioUnlocked = true; // 即使失败也标记为已尝试
              });
          } else {
              this.state.audioUnlocked = true;
          }
          
          // 清理
          setTimeout(() => {
              silentAudio.pause();
              silentAudio.currentTime = 0;
              if (audioContext.state !== 'closed') {
                  audioContext.close();
              }
          }, 100);
          
      } catch (error) {
          console.warn('音频解锁过程出错:', error);
          this.state.audioUnlocked = true; // 标记为已尝试
      }
  }

  /**
   * 检测是否为移动端设备
   * @returns {boolean}
   * @private
   */
  _isMobileDevice() {
      return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  }

  /**
   * 检测是否为iOS设备
   * @returns {boolean}
   * @private
   */
  _isIOSDevice() {
      return /iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  /**
   * 销毁TTS服务
   */
  destroy() {
      this.stop();
      this.state.audioQueue = [];
      this.callbacks = {
          onStart: null,
          onEnd: null,
          onError: null,
          onProgress: null
      };
      console.log('TTS服务已销毁');
  }
}

// 导出TTS服务类
window.TTSService = TTSService;

// 创建默认实例（可选）
window.ttsService = null;

/**
* 初始化默认TTS服务实例
* @param {Object} config 配置对象
* @returns {TTSService} TTS服务实例
*/
window.initTTS = function(config) {
  window.ttsService = new TTSService(config);
  return window.ttsService;
};

console.log('TTS模块加载完成');