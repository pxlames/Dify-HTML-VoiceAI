from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import tempfile
import os
import logging
from pathlib import Path
import asyncio
import traceback

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="STT Service", version="1.0.0")

# 配置CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 全局模型变量
model = None
model_initialized = False

def initialize_model():
    """初始化STT模型"""
    global model, model_initialized
    
    try:
        logger.info("正在初始化STT模型...")
        
        from funasr import AutoModel
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
        
        model_dir = "/home/bygpu/model/iic/SenseVoiceSmall"
        
        model = AutoModel(
            model=model_dir,
            trust_remote_code=True,
            remote_code=model_dir,  
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 30000},
            device="cuda:0",
        )
        
        model_initialized = True
        logger.info("STT模型初始化成功!")
        
    except Exception as e:
        logger.error(f"模型初始化失败: {e}")
        logger.error(traceback.format_exc())
        model_initialized = False
        raise e

# 启动时初始化模型
@app.on_event("startup")
async def startup_event():
    """应用启动时初始化模型"""
    try:
        await asyncio.get_event_loop().run_in_executor(None, initialize_model)
    except Exception as e:
        logger.error(f"启动时模型初始化失败: {e}")

@app.post("/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    language: str = "auto"  # auto, zh, en, yue, ja, ko
):
    """
    语音转文字接口
    """
    if not model_initialized or model is None:
        raise HTTPException(status_code=503, detail="STT模型未初始化或初始化失败")
    
    # 检查文件类型
    allowed_types = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/webm']
    if audio.content_type not in allowed_types:
        logger.warning(f"不支持的文件类型: {audio.content_type}")
        # 仍然尝试处理，因为有时浏览器可能发送错误的content_type
    
    try:
        # 保存上传的音频文件到临时目录
        with tempfile.NamedTemporaryFile(delete=False, suffix='.wav') as temp_file:
            content = await audio.read()
            temp_file.write(content)
            temp_file_path = temp_file.name
        
        logger.info(f"接收到音频文件: {audio.filename}, 大小: {len(content)} bytes, 临时路径: {temp_file_path}")
        
        try:
            # 执行语音识别
            def transcribe():
                from funasr.utils.postprocess_utils import rich_transcription_postprocess
                
                # 设置语言参数
                lang_param = "auto" if language == "auto" else language
                
                res = model.generate(
                    input=temp_file_path,
                    cache={},
                    language=lang_param,
                    use_itn=True,
                    batch_size_s=60,
                    merge_vad=True,
                    merge_length_s=15,
                )
                
                if res and len(res) > 0:
                    raw_text = res[0]["text"]
                    processed_text = rich_transcription_postprocess(raw_text)
                    return {
                        "raw_text": raw_text,
                        "processed_text": processed_text,
                        "language": res[0].get("language", "unknown") if "language" in res[0] else "unknown"
                    }
                else:
                    return {"raw_text": "", "processed_text": "", "language": "unknown"}
            
            # 在线程池中执行识别任务
            result = await asyncio.get_event_loop().run_in_executor(None, transcribe)
            
            logger.info(f"转录完成: {result['processed_text']}")
            
            return {
                "success": True,
                "text": result["processed_text"],
                "raw_text": result["raw_text"],
                "detected_language": result["language"],
                "file_info": {
                    "filename": audio.filename,
                    "size": len(content),
                    "content_type": audio.content_type
                }
            }
            
        except Exception as e:
            logger.error(f"语音识别过程中出错: {e}")
            logger.error(traceback.format_exc())
            raise HTTPException(status_code=500, detail=f"语音识别失败: {str(e)}")
            
    except Exception as e:
        logger.error(f"处理音频文件时出错: {e}")
        raise HTTPException(status_code=500, detail=f"处理音频文件失败: {str(e)}")
        
    finally:
        # 清理临时文件
        try:
            if 'temp_file_path' in locals():
                os.unlink(temp_file_path)
                logger.info(f"已删除临时文件: {temp_file_path}")
        except Exception as e:
            logger.warning(f"删除临时文件失败: {e}")

@app.get("/")
async def root():
    return {
        "message": "STT语音转文字服务", 
        "model_status": "已初始化" if model_initialized else "未初始化"
    }

@app.get("/health")
async def health():
    return {
        "status": "healthy" if model_initialized else "model_not_ready",
        "model_initialized": model_initialized
    }

@app.get("/model/info")
async def model_info():
    """获取模型信息"""
    if not model_initialized:
        return {"error": "模型未初始化"}
    
    return {
        "model_path": "/home/bygpu/model/iic/SenseVoiceSmall",
        "supported_languages": ["auto", "zh", "en", "yue", "ja", "ko"],
        "features": ["VAD", "ITN", "语音活动检测", "逆文本标准化"],
        "status": "ready"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")