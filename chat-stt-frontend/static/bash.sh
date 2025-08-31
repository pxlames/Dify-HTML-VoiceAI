# 定义要检查的端口
PORTS=(8002)

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

# 定义文件夹变量
PROJECT_DIR="/home/bygpu/Documents/chat-stt-frontend"

# 执行命令
cd "$PROJECT_DIR"
nohup node "$PROJECT_DIR/node_front_server.js" > "$PROJECT_DIR/log/node.log" 2>&1 &