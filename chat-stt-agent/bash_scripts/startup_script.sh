#!/bin/bash

# requirements.txt 内容
cat > requirements.txt << EOF
fastapi==0.104.1
uvicorn[standard]==0.24.0
requests==2.31.0
pydantic==2.4.2
python-multipart==0.0.6
EOF

echo "📦 安装依赖包..."
pip install -r requirements.txt


# 启动FastAPI服务
# 定义要检查的端口
PORTS=(8000)

# 停止占用指定端口的进程
for port in "${PORTS[@]}"; do
    echo "检查端口 $port 是否被占用..."
    # 查找占用端口的进程ID
    pid=$(lsof -t -i:$port)
    if [ -n "$pid" ]; then
        echo "端口 $port 被进程 $pid 占用，正在终止..."
        kill -9 $pid
        if [ $? -eq 0 ]; then
            echo "进程 $pid 已成功终止"
        else
            echo "终止进程 $pid 失败"
        fi
    else
        echo "端口 $port 未被占用"
    fi
done

cd /home/bygpu/Documents/chat-stt-agent
# 启动FastAPI服务
echo "启动fastapi_backend服务..."
nohup python /home/bygpu/Documents/chat-stt-agent/fastapi_backend.py > log/app.log 2>&1 &

# # 启动ASR服务
# echo "启动asr_backend服务..."
# nohup python /home/bygpu/Documents/chat-stt-agent/asr_backend.py > log/asr.log 2>&1 &

# echo "所有服务启动命令已执行完毕"


# 启动前端node服务
# echo "正在启动node服务"
# nohup node /home/bygpu/Documents/chat-stt-agent/node_front_server.js > log/node.log 2>&1 &

