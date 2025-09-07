# 小普同学 - AI语音助手

一个基于Web技术的智能语音交互系统，支持实时语音识别、智能对话和语音合成功能。

## 🌟 功能特性

### 核心功能
- **实时语音识别 (STT)**: 基于Web Audio API的高质量语音转文字
- **智能对话 (Chat)**: 支持流式响应的AI对话系统
- **语音合成 (TTS)**: 基于SiliconFlow API的自然语音播放
- **噪声过滤**: 智能音频预处理，有效过滤环境噪声
- **语音活动检测 (VAD)**: 自动检测语音开始和结束
- **中断机制**: 支持语音打断当前播放，实现自然对话

### 技术特性
- **自适应阈值**: 根据环境噪声动态调整检测阈值
- **频率分析**: 基于语音频段(300-3400Hz)的智能分析
- **音频预处理**: 高通滤波、低通滤波、动态压缩
- **流式处理**: 支持实时音频流处理和响应
- **移动端优化**: 支持移动设备音频解锁和播放

## 🚀 快速开始

### 环境要求
- Node.js 14+ 
- 现代浏览器 (支持Web Audio API)
- 麦克风权限

### 安装步骤

1. **克隆项目**
```bash
git clone <repository-url>
cd chat-stt-frontend-2
```

2. **安装依赖**
```bash
npm install
```

3. **配置API密钥**
编辑 `static/config/total_config.yml`:
```yaml
name: AI语音助手
version: 1.0.0
author: developer
apiToken: your-api-token-here
API_BASE: https://your-api-base-url
dify_voice_apikey: your-dify-api-key
```

4. **启动服务**
```bash
node node_front_server.js
```

5. **访问应用**
打开浏览器访问: `http://localhost:3000`

## 📁 项目结构

```
chat-stt-frontend-2/
├── static/
│   ├── chat_frontend.html      # 主页面
│   ├── script.js              # 核心JavaScript逻辑
│   ├── tts_service.js         # TTS语音合成服务
│   ├── config/
│   │   ├── total_config.yml   # 主配置文件
│   │   └── total_config_example.yml  # 配置示例
│   └── bash.sh                # 启动脚本
├── log/                       # 日志目录
├── node_front_server.js       # Node.js服务器
└── README.md                  # 项目说明
```

## ⚙️ 配置说明

### 主要配置参数

#### 语音检测配置
```javascript
CONFIG = {
    VOICE_DETECTION_THRESHOLD: 0.2,    // 声音检测阈值
    SILENCE_THRESHOLD: 0.1,            // 静音检测阈值
    SILENCE_DURATION: 1500,            // 静音持续时间(ms)
    RECORDING_TIMEOUT: 10000,          // 最大录音时长(ms)
    QUESTION_DELAY: 1000,              // 问题延迟(ms)
}
```

#### 噪声过滤配置
```javascript
NOISE_FILTER: {
    enabled: true,                      // 启用噪声过滤
    noiseFloor: 0.01,                  // 噪声底噪阈值
    voiceFreqMin: 300,                 // 语音最低频率(Hz)
    voiceFreqMax: 3400,                // 语音最高频率(Hz)
    noiseFreqMin: 4000,                // 噪声检测频率(Hz)
    smoothingFactor: 0.7,              // 音量平滑系数
    adaptiveThreshold: true,           // 自适应阈值
    voicePresenceThreshold: 0.3,       // 语音存在阈值
    noiseRatioThreshold: 0.4           // 噪声比例阈值
}
```

#### TTS配置
```javascript
TTS: {
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',  // 语音模型
    enabled: true,                               // 启用TTS
    timeout: 30000,                             // 超时时间(ms)
    speed: 2.5,                                 // 播放速度
    saveAudioFiles: true                        // 保存音频文件
}
```

## 🎯 使用指南

### 基本操作
1. **开始对话**: 点击"开始录音"按钮或直接说话
2. **结束录音**: 停止说话1.5秒后自动结束，或点击"停止录音"
3. **中断播放**: 在AI回复时说话可以中断当前播放
4. **查看状态**: 界面显示当前系统状态和对话历史

### 调试功能
在浏览器控制台中可以使用以下调试命令：

```javascript
// 查看系统状态
getSystemStatus();

// 调试当前音频分析
debugCurrentAudio();

// 查看噪声过滤状态
getNoiseFilterStatus();

// 切换噪声过滤
toggleNoiseFilter();

// 调整噪声过滤参数
adjustNoiseFilter({
    voicePresenceThreshold: 0.3,
    noiseRatioThreshold: 0.4
});

// 测试流式响应
testStreamResponse();

// 模拟流式数据
simulateStreamData();
```

## 🔧 技术架构

### 前端技术栈
- **HTML5**: 页面结构和UI
- **CSS3**: 响应式设计和动画效果
- **JavaScript ES6+**: 核心业务逻辑
- **Web Audio API**: 音频采集和处理
- **MediaRecorder API**: 音频录制
- **Server-Sent Events (SSE)**: 流式数据接收

### 后端服务
- **Node.js**: HTTP服务器
- **文件服务**: 静态文件托管
- **API代理**: 转发请求到后端服务
- **压缩支持**: Gzip/Deflate压缩

### 音频处理流程
```
麦克风 → Web Audio API → 音频预处理 → 频率分析 → 噪声过滤 → 语音检测 → 录音 → STT → Chat → TTS → 播放
```

## 🎵 音频处理详解

### 音频预处理链
1. **高通滤波器**: 80Hz截止，去除低频噪声
2. **低通滤波器**: 8kHz截止，限制带宽
3. **动态压缩器**: 压缩动态范围，提高稳定性
4. **频谱分析器**: 实时频率分析

### 语音质量评估
- **语音存在概率**: 基于300-3400Hz频段能量
- **噪声比例**: 基于4000Hz以上频段能量
- **动态阈值**: 根据环境自适应调整
- **质量评分**: 多维度综合评估

## 🐛 故障排除

### 常见问题

1. **无法录音**
   - 检查麦克风权限
   - 确认浏览器支持Web Audio API
   - 查看控制台错误信息

2. **语音识别不准确**
   - 调整 `VOICE_DETECTION_THRESHOLD`
   - 检查环境噪声水平
   - 使用 `debugCurrentAudio()` 调试

3. **TTS播放异常**
   - 检查API密钥配置
   - 确认网络连接
   - 查看TTS服务状态

4. **流式响应不显示**
   - 检查后端API状态
   - 使用 `testStreamResponse()` 测试
   - 查看网络请求日志

### 调试工具
- 浏览器开发者工具控制台
- 内置调试函数
- 详细日志输出
- 实时状态监控

## 📝 更新日志

### v1.0.0 (当前版本)
- ✅ 基础语音识别和对话功能
- ✅ 智能噪声过滤系统
- ✅ 自适应阈值调整
- ✅ 流式响应处理
- ✅ TTS语音合成集成
- ✅ 移动端音频支持
- ✅ 完整的调试工具集

## 🤝 贡献指南

1. Fork 项目
2. 创建功能分支
3. 提交更改
4. 推送到分支
5. 创建 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 📞 支持

如有问题或建议，请通过以下方式联系：
- 提交 Issue
- 发送邮件
- 查看文档

---

**小普同学** - 让AI语音交互更自然、更智能！
