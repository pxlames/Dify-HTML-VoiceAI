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
          isProcessing: false
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
          voice: options.voice || this.config.voice
      };

      console.log('TTS API请求:', requestBody);

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
          const audioUrl = URL.createObjectURL(audioBlob);
          const audio = new Audio(audioUrl);

          // 设置音频属性
          audio.volume = 1.0;
          audio.preload = 'auto';

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
              
              const errorMsg = `音频播放失败: ${error.message || '未知错误'}`;
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

          audio.play().catch(error => {
              this.state.isSpeaking = false;
              this.state.currentAudio = null;
              URL.revokeObjectURL(audioUrl);
              reject(new Error(`音频播放启动失败: ${error.message}`));
          });
      });
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