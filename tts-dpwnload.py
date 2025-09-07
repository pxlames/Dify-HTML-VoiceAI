from modelscope import snapshot_download

# 指定模型下载目录
model_dir = snapshot_download(
    'iic/SenseVoiceSmall',
    cache_dir='/home/bygpu/model'  # 替换为你的目标目录路径
)

print(f"模型已下载至: {model_dir}")