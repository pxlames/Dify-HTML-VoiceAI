from fastapi import FastAPI, HTTPException, File, UploadFile, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import requests
import json
import asyncio
import logging
import tempfile
import os
import traceback
from typing import Optional
from pathlib import Path
import yaml

# -------------------------- 基础配置 --------------------------
# 日志配置
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# FastAPI 实例
app = FastAPI(title="Dify + STT Integrated API", version="1.0.0")

# CORS 配置（统一处理跨域）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境需替换为具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------- 外部服务配置 --------------------------
# 读取yml配置文件
yaml_file = "config/total_config.yml"
def load_yaml_config(yaml_file_path):
    """
    从YAML文件中读取配置
    
    Args:
        yaml_file_path (str): YAML文件路径
    
    Returns:
        dict: 解析后的配置字典
    """
    try:
        with open(yaml_file_path, 'r', encoding='utf-8') as file:
            config = yaml.safe_load(file)
        return config
    except FileNotFoundError:
        print(f"错误：找不到文件 {yaml_file_path}")
        return None
    except yaml.YAMLError as e:
        print(f"错误：解析YAML文件失败 - {e}")
        return None
config = load_yaml_config(yaml_file)
# Dify API 配置
DIFY_CONFIG = {
    "url": "http://localhost/v1",
    "key": config.get('dify_voice_apikey', '') if config else '',
    "user": "test"
}

print(DIFY_CONFIG)
# STT 模型全局变量（懒加载初始化）
STT_MODEL = None
STT_MODEL_INITIALIZED = False
STT_MODEL_DIR = "/home/bygpu/model/iic/SenseVoiceSmall"


# -------------------------- 数据模型 --------------------------
class ChatRequest(BaseModel):
    """对话请求模型"""
    query: str
    conversation_id: Optional[str] = ""


# -------------------------- STT 模型初始化 --------------------------
def initialize_stt_model():
    """同步初始化STT模型（FunASR）"""
    global STT_MODEL, STT_MODEL_INITIALIZED
    try:
        logger.info("开始初始化STT模型...")
        from funasr import AutoModel
        # 加载模型（含VAD）
        STT_MODEL = AutoModel(
            model=STT_MODEL_DIR,
            trust_remote_code=True,
            remote_code=STT_MODEL_DIR,
            vad_model="fsmn-vad",
            vad_kwargs={"max_single_segment_time": 30000},
            device="cuda:0",  # 若用CPU则改为"cpu"
        )
        STT_MODEL_INITIALIZED = True
        logger.info("STT模型初始化成功！")
    except Exception as e:
        logger.error(f"STT模型初始化失败: {str(e)}")
        logger.error(traceback.format_exc())
        STT_MODEL_INITIALIZED = False
        raise e


# 启动时初始化STT模型（异步线程执行，避免阻塞服务启动）
@app.on_event("startup")
async def startup_event():
    await asyncio.get_event_loop().run_in_executor(None, initialize_stt_model)


# -------------------------- 核心接口 --------------------------
@app.post("/chat")
async def chat(request: ChatRequest):
    """
    Dify对话接口（流式响应）
    - 接收用户查询和对话ID
    - 转发请求到Dify API并返回流式结果
    """
    try:
        # 构建Dify请求参数
        dify_url = f"{DIFY_CONFIG['url']}/chat-messages"
        headers = {
            "Authorization": f"Bearer {DIFY_CONFIG['key']}",
            "Content-Type": "application/json"
        }
        request_data = {
            "inputs": {},
            "query": request.query,
            "response_mode": "streaming",
            "conversation_id": request.conversation_id,
            "user": DIFY_CONFIG["user"]
        }

        logger.info(f"转发对话请求: query={request.query[:50]}..., conversation_id={request.conversation_id}")
        # 发起流式请求（禁用verify=False，生产环境需配置SSL）
        dify_response = requests.post(
            dify_url,
            headers=headers,
            json=request_data,
            stream=True,
            verify=False  # 仅测试用，生产环境删除
        )

        # 检查Dify响应状态
        if dify_response.status_code != 200:
            error_msg = f"Dify请求失败: {dify_response.status_code} - {dify_response.text[:100]}"
            logger.error(error_msg)
            raise HTTPException(status_code=dify_response.status_code, detail=error_msg)

        # 返回流式响应
        return StreamingResponse(
            parse_dify_stream(dify_response),
            media_type="text/plain; charset=utf-8"
        )

    except requests.exceptions.RequestException as e:
        logger.error(f"Dify请求异常: {str(e)}")
        raise HTTPException(status_code=503, detail=f"Dify服务不可用: {str(e)}")
    except Exception as e:
        logger.error(f"对话接口异常: {str(e)}")
        raise HTTPException(status_code=500, detail=f"服务错误: {str(e)}")


async def parse_dify_stream(dify_response):
    """解析Dify流式响应，格式化后返回"""
    complete_answer = ""
    conversation_id = ""
    message_id = ""

    try:
        for line in dify_response.iter_lines():
            if not line:
                continue
            decoded_line = line.decode("utf-8").strip()

            # 跳过ping事件
            if decoded_line == "event: ping":
                continue

            # 处理数据行
            if decoded_line.startswith("data: "):
                json_str = decoded_line[6:]  # 移除"data: "前缀
                try:
                    data = json.loads(json_str)
                    event_type = data.get("event", "unknown")
                    result = {"event": event_type, "data": data}

                    # 补充关键信息
                    if event_type == "workflow_started":
                        conversation_id = data.get("conversation_id", "")
                        message_id = data.get("message_id", "")
                        result.update({"conversation_id": conversation_id, "message_id": message_id})
                    elif event_type == "message":
                        answer_part = data.get("answer", "")
                        complete_answer += answer_part
                        result.update({"answer_part": answer_part, "complete_answer": complete_answer})
                    elif event_type == "workflow_finished":
                        final_answer = data.get("data", {}).get("outputs", {}).get("answer", complete_answer)
                        result.update({"final_answer": final_answer, "conversation_id": conversation_id})

                    # 流式返回JSON格式数据
                    yield f"data: {json.dumps(result, ensure_ascii=False)}\n\n"
                    await asyncio.sleep(0.01)  # 避免前端处理过快

                except json.JSONDecodeError:
                    # 非JSON格式数据直接返回
                    yield f"data: {json.dumps({'event': 'raw', 'raw_data': json_str}, ensure_ascii=False)}\n\n"
    except Exception as e:
        logger.error(f"流式解析异常: {str(e)}")
        yield f"data: {json.dumps({'event': 'error', 'error': str(e)}, ensure_ascii=False)}\n\n"


@app.post("/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    language: str = Query("auto", description="识别语言: auto/zh/en/yue/ja/ko")
):
    """
    语音转文字接口（STT）
    - 支持WAV/MP3/OGG等音频格式
    - 返回处理后文本和原始文本
    """
    # 检查模型状态
    if not STT_MODEL_INITIALIZED or STT_MODEL is None:
        raise HTTPException(status_code=503, detail="STT模型未初始化或初始化失败")

    # 临时文件处理
    temp_file_path = None
    try:
        # 保存上传文件到临时目录
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_file:
            audio_content = await audio.read()
            temp_file.write(audio_content)
            temp_file_path = temp_file.name

        logger.info(f"接收音频: {audio.filename}, 大小: {len(audio_content)}B, 临时路径: {temp_file_path}")

        # 语音识别（同步任务放入线程池，避免阻塞事件循环）
        def stt_transcribe():
            from funasr.utils.postprocess_utils import rich_transcription_postprocess
            # 执行识别
            result = STT_MODEL.generate(
                input=temp_file_path,
                cache={},
                language=language,
                use_itn=True,  # 逆文本标准化（数字转文字等）
                batch_size_s=60,
                merge_vad=True,  # 合并VAD分段
                merge_length_s=15
            )
            # 处理结果
            if result and len(result) > 0:
                raw_text = result[0]["text"]
                processed_text = rich_transcription_postprocess(raw_text)
                return {
                    "raw_text": raw_text,
                    "processed_text": processed_text,
                    "detected_lang": result[0].get("language", "unknown")
                }
            return {"raw_text": "", "processed_text": "", "detected_lang": "unknown"}

        stt_result = await asyncio.get_event_loop().run_in_executor(None, stt_transcribe)
        logger.info(f"识别完成: {stt_result['processed_text'][:50]}...")

        # 返回结果
        return {
            "success": True,
            "text": stt_result["processed_text"],
            "raw_text": stt_result["raw_text"],
            "detected_language": stt_result["detected_lang"],
            "file_info": {
                "filename": audio.filename,
                "size": len(audio_content),
                "content_type": audio.content_type
            }
        }

    except Exception as e:
        logger.error(f"语音识别异常: {str(e)}")
        logger.error(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"识别失败: {str(e)}")
    finally:
        # 清理临时文件
        if temp_file_path and os.path.exists(temp_file_path):
            try:
                os.unlink(temp_file_path)
                logger.info(f"删除临时文件: {temp_file_path}")
            except Exception as e:
                logger.warning(f"临时文件删除失败: {str(e)}")


# -------------------------- 基础接口 --------------------------
@app.get("/")
async def root():
    """根路径健康提示"""
    return {
        "service": "Dify + STT Integrated API",
        "status": "running",
        "port": 8000,
        "apis": ["/chat (POST)", "/transcribe (POST)"],
        "stt_model_status": "ready" if STT_MODEL_INITIALIZED else "not_ready"
    }


@app.get("/health")
async def health_check():
    """健康检查接口"""
    # 检查Dify服务连通性
    dify_status = "unavailable"
    try:
        dify_health_url = f"{DIFY_CONFIG['url']}/health"  # 需确保Dify有health接口
        dify_resp = requests.get(dify_health_url, timeout=3, verify=False)
        dify_status = "healthy" if dify_resp.status_code == 200 else "error"
    except Exception:
        dify_status = "unavailable"

    return {
        "overall_status": "healthy" if STT_MODEL_INITIALIZED and dify_status == "healthy" else "degraded",
        "stt_model": {"initialized": STT_MODEL_INITIALIZED},
        "dify_service": {"status": dify_status}
    }


# -------------------------- 启动服务 --------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app="__main__:app",
        host="0.0.0.0",
        port=8000,
        log_level="info",
        workers=1  # STT模型不支持多进程，workers固定为1
    )