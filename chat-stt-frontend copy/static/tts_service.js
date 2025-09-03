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
          enabled: config.enabled !== true, // 默认启用
          timeout: config.timeout || 30000, // 30秒超时
          speed: 2.5,
          saveAudioFiles: config.saveAudioFiles !== true, // 默认保存音频文件
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

      // 移动端自动解锁音频
      this._setupMobileAudioUnlock();
      
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
   * 启用/禁用音频文件保存
   * @param {boolean} enabled 是否启用音频文件保存
   */
  setSaveAudioFiles(enabled) {
      this.config.saveAudioFiles = enabled;
      console.log('音频文件保存功能:', enabled ? '已启用' : '已禁用');
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
      
      // 移动端预先检查音频解锁状态
      if (this._isMobileDevice() && !this.state.audioUnlocked) {
          console.warn('移动端音频未解锁，尝试解锁...');
          await this.unlockAudio();
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
          
          // 保存音频文件到本地（如果启用）
          if (this.config.saveAudioFiles) {
              await this._saveAudioFile(audioBlob, text);
          }
          
          // 播放音频（带重试机制）
          await this._playAudioWithRetry(audioBlob, options.retries || 2);

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
          
          // 为iOS Safari和Android创建正确的音频Blob
          let finalBlob = audioBlob;
          if (this._isMobileDevice()) {
              // 移动端需要正确的MIME类型
              if (!audioBlob.type || audioBlob.type === 'application/octet-stream') {
                  console.log('为移动设备设置MP3 MIME类型');
                  finalBlob = new Blob([audioBlob], { type: 'audio/mpeg' });
              }
          }

          const audioUrl = URL.createObjectURL(finalBlob);
          const audio = new Audio(audioUrl);

          // 设置音频属性 - 参考audio_test.html最佳实践
          audio.volume = 1.0;
          audio.preload = 'metadata'; // 移动端使用metadata更稳定
          
          // 移动端特殊设置
          if (this._isMobileDevice()) {
              const browserInfo = this._getMobileBrowserInfo();
              
              audio.setAttribute('playsinline', true);
              audio.setAttribute('webkit-playsinline', true);
              audio.crossOrigin = 'anonymous';
              
              // iOS Safari特殊处理
              if (browserInfo.isIOS) {
                  audio.setAttribute('-webkit-user-select', 'none');
                  audio.style.touchAction = 'manipulation';
                  if (browserInfo.isSafari) {
                      // Safari 特殊处理
                      audio.muted = false;
                      audio.loop = false;
                      // iOS Safari 需要这个属性来避免播放问题
                      audio.setAttribute('-webkit-appearance', 'none');
                  }
              }
              
              // Android特殊处理
              if (browserInfo.isAndroid) {
                  // Chrome for Android
                  if (browserInfo.isChrome) {
                      audio.preload = 'metadata';
                  }
                  // Samsung Browser
                  if (browserInfo.isSamsung) {
                      audio.preload = 'none';
                  }
              }
              
              // 微信内置浏览器特殊处理
              if (browserInfo.isWechat) {
                  audio.preload = 'metadata';
                  audio.setAttribute('x5-video-player-type', 'h5');
                  audio.setAttribute('x5-video-player-fullscreen', 'false');
              }
          } else {
              audio.preload = 'auto';
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

          // 音频加载事件
          audio.onloadedmetadata = () => {
              console.log('音频元数据加载完成，时长:', audio.duration);
          };
          
          audio.oncanplaythrough = () => {
              console.log('音频缓冲完成，可以播放');
          };
          
          // 移动端播放就绪事件
          audio.oncanplay = () => {
              if (this._isMobileDevice()) {
                  console.log('移动端音频准备就绪');
              }
          };

          // 开始播放
          this.state.currentAudio = audio;
          this.state.isSpeaking = true;

          // 移动端播放处理
          const playPromise = audio.play();
          if (playPromise !== undefined) {
              playPromise.then(() => {
                  console.log('音频播放成功启动');
              }).catch(error => {
                  this.state.isSpeaking = false;
                  this.state.currentAudio = null;
                  URL.revokeObjectURL(audioUrl);
                  
                  let errorMessage = `音频播放启动失败: ${error.message}`;
                  
                  // 移动端特殊错误处理
                  if (this._isMobileDevice()) {
                      const browserInfo = this._getMobileBrowserInfo();
                      console.error('移动端播放失败:', error.name, error.message, browserInfo);
                      
                      if (error.name === 'NotAllowedError') {
                          if (browserInfo.isIOS && browserInfo.isSafari) {
                              errorMessage += ' - iOS Safari阻止了音频播放，请点击页面任意位置后重试';
                          } else if (browserInfo.isAndroid) {
                              if (browserInfo.isChrome) {
                                  errorMessage += ' - Chrome for Android阻止了音频播放，请在设置中允许自动播放';
                              } else {
                                  errorMessage += ' - Android浏览器阻止了音频播放，请允许自动播放或点击页面后重试';
                              }
                          } else if (browserInfo.isWechat) {
                              errorMessage += ' - 微信内置浏览器需要用户交互后才能播放音频';
                          }
                          // 自动尝试解锁音频
                          this.unlockAudio();
                      } else if (error.name === 'NotSupportedError') {
                          errorMessage += ' - 移动端不支持此音频格式，已使用MP3格式但仍失败';
                      } else if (error.name === 'AbortError') {
                          errorMessage += ' - 播放被中止';
                      }
                  }
                  
                  reject(new Error(errorMessage));
              });
          } else {
              // 旧版本浏览器兼容
              console.log('音频播放启动（同步方式）');
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
          return Promise.resolve();
      }
      
      return new Promise((resolve) => {
          try {
              // 创建一个静音的短音频来解锁音频播放权限
              const silentAudio = new Audio();
              silentAudio.volume = 0;
              silentAudio.muted = true;
              
              // 移动端特殊处理
              if (this._isMobileDevice()) {
                  const browserInfo = this._getMobileBrowserInfo();
                  silentAudio.setAttribute('playsinline', true);
                  silentAudio.setAttribute('webkit-playsinline', true);
                  silentAudio.preload = 'metadata';
                  
                  // 微信特殊处理
                  if (browserInfo.isWechat) {
                      silentAudio.setAttribute('x5-video-player-type', 'h5');
                  }
              }
              
              // 创建一个极短的空白音频数据URL
              const emptyAudioData = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
              silentAudio.src = emptyAudioData;
              
              // 播放静音音频来解锁
              const promise = silentAudio.play();
              if (promise) {
                  promise.then(() => {
                      this.state.audioUnlocked = true;
                      console.log('移动端音频播放权限已解锁');
                      resolve();
                  }).catch(error => {
                      console.warn('音频解锁失败，但这通常不影响后续播放:', error);
                      this.state.audioUnlocked = true; // 即使失败也标记为已尝试
                      resolve();
                  });
              } else {
                  this.state.audioUnlocked = true;
                  resolve();
              }
              
              // 清理
              setTimeout(() => {
                  try {
                      silentAudio.pause();
                      silentAudio.currentTime = 0;
                      silentAudio.src = '';
                  } catch (e) {
                      // 忽略清理错误
                  }
              }, 200);
              
          } catch (error) {
              console.warn('音频解锁过程出错:', error);
              this.state.audioUnlocked = true; // 标记为已尝试
              resolve();
          }
      });
  }

  /**
   * 检测是否为移动端设备
   * @returns {boolean}
   * @private
   */
  _isMobileDevice() {
      const userAgent = navigator.userAgent;
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      return isMobile || isTouch;
  }
  
  /**
   * 检测是否为Android设备
   * @returns {boolean}
   * @private
   */
  _isAndroidDevice() {
      return /Android/i.test(navigator.userAgent);
  }
  
  /**
   * 获取移动端浏览器信息
   * @returns {Object}
   * @private
   */
  _getMobileBrowserInfo() {
      const userAgent = navigator.userAgent;
      return {
          isIOS: this._isIOSDevice(),
          isAndroid: this._isAndroidDevice(),
          isSafari: /Safari/i.test(userAgent) && !/Chrome/i.test(userAgent),
          isChrome: /Chrome/i.test(userAgent),
          isFirefox: /Firefox/i.test(userAgent),
          isSamsung: /SamsungBrowser/i.test(userAgent),
          isWechat: /MicroMessenger/i.test(userAgent)
      };
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
   * 设置移动端音频自动解锁
   * @private
   */
  _setupMobileAudioUnlock() {
      if (!this._isMobileDevice()) return;
      
      const unlockEvents = ['touchstart', 'touchend', 'click', 'tap'];
      const unlockHandler = () => {
          if (!this.state.audioUnlocked) {
              this.unlockAudio().then(() => {
                  console.log('移动端音频自动解锁完成');
              });
              // 移除事件监听器
              unlockEvents.forEach(event => {
                  document.removeEventListener(event, unlockHandler, true);
              });
          }
      };
      
      // 添加事件监听器
      unlockEvents.forEach(event => {
          document.addEventListener(event, unlockHandler, { once: true, capture: true });
      });
      
      const browserInfo = this._getMobileBrowserInfo();
      console.log(`移动端音频自动解锁监听器已设置 - ${JSON.stringify(browserInfo)}`);
  }
  
  /**
   * 带重试机制的音频播放
   * @param {Blob} audioBlob 音频数据
   * @param {number} retries 重试次数
   * @returns {Promise<void>}
   * @private
   */
  async _playAudioWithRetry(audioBlob, retries = 2) {
      for (let attempt = 0; attempt <= retries; attempt++) {
          try {
              await this._playAudio(audioBlob);
              return; // 播放成功，退出
          } catch (error) {
              console.warn(`音频播放失败 (第${attempt + 1}次尝试):`, error.message);
              
              // 如果是移动端权限问题，尝试解锁后重试
              if (this._isMobileDevice() && (error.message.includes('NotAllowedError') || error.name === 'NotAllowedError')) {
                  console.log('检测到移动端权限问题，尝试解锁音频...');
                  await this.unlockAudio();
                  // 稍等片刻再重试
                  await new Promise(resolve => setTimeout(resolve, 300));
              }
              
              // 如果是最后一次尝试，抛出错误
              if (attempt === retries) {
                  throw error;
              }
              
              // 等待一段时间后重试
              await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          }
      }
  }

  /**
   * 保存音频文件到本地目录
   * @param {Blob} audioBlob 音频数据
   * @param {string} text 原始文本，用于生成文件名
   * @private
   */
  async _saveAudioFile(audioBlob, text) {
      try {
          // 生成文件名（使用时间戳和文本的前20个字符）
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          const textPreview = text.slice(0, 20).replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
          const fileName = `tts_${timestamp}_${textPreview}.mp3`;
          
          console.log('保存音频文件:', fileName);
          
          // 使用浏览器的下载功能保存文件
          const url = URL.createObjectURL(audioBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          a.style.display = 'none';
          
          // 添加到DOM，点击下载，然后移除
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          
          // 释放URL对象
          setTimeout(() => {
              URL.revokeObjectURL(url);
          }, 100);
          
          console.log(`✅ 音频文件已保存: ${fileName}`);
          
      } catch (error) {
          console.warn('保存音频文件失败:', error);
          // 保存失败不影响播放，继续执行
      }
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