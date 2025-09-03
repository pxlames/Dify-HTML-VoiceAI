const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// MIME类型映射
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.webm': 'audio/webm'
};

// 获取文件的MIME类型
function getMimeType(filePath) {
    const extname = path.extname(filePath).toLowerCase();
    return mimeTypes[extname] || 'application/octet-stream';
}

// 设置CORS响应头
function setCorsHeaders(res) {
    // 允许所有来源访问，生产环境中应指定具体域名
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // 允许的请求方法
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    
    // 允许的请求头
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // 预检请求的有效期（秒）
    res.setHeader('Access-Control-Max-Age', '86400');
}

// 服务静态文件
function serveStaticFile(res, filePath) {
    // 设置CORS头
    setCorsHeaders(res);
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // 文件不存在
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end(`
                    <h1>404 - 页面未找到</h1>
                    <p>请求的文件不存在: ${filePath}</p>
                    <a href="/">返回首页</a>
                `);
            } else {
                // 服务器错误
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end('<h1>500 - 服务器内部错误</h1>');
            }
        } else {
            // 成功读取文件
            const mimeType = getMimeType(filePath);
            res.writeHead(200, { 
                'Content-Type': mimeType,
                'Cache-Control': 'public, max-age=3600' // 缓存1小时
            });
            res.end(content);
        }
    });
}

// 创建服务器
const server = http.createServer((req, res) => {
    // 处理OPTIONS预检请求
    if (req.method === 'OPTIONS') {
        setCorsHeaders(res);
        res.writeHead(204); // 无内容响应
        res.end();
        return;
    }
    
    // 解析请求URL
    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname;
    
    // 处理根路径，默认返回index.html
    if (pathname === '/') {
        pathname = '/index.html';
    }
    
    // 构建文件路径
    const filePath = path.join(__dirname, 'static', pathname);
    
    // 安全检查：防止访问上级目录
    const staticDir = path.join(__dirname, 'static');
    const resolvedPath = path.resolve(filePath);
    
    if (!resolvedPath.startsWith(staticDir)) {
        setCorsHeaders(res); // 即使是403响应也需要设置CORS头
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<h1>403 - 禁止访问</h1>');
        return;
    }
    
    // 检查文件是否存在
    fs.stat(filePath, (err, stat) => {
        // 设置CORS头
        setCorsHeaders(res);
        
        if (err) {
            // 文件不存在，尝试查找是否有对应的文件
            if (pathname.endsWith('/')) {
                // 目录请求，尝试index.html
                serveStaticFile(res, path.join(filePath, 'index.html'));
            } else {
                // 文件不存在
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end(`
                    <h1>404 - 页面未找到</h1>
                    <p>请求的文件不存在: ${pathname}</p>
                    <a href="/">返回首页</a>
                `);
            }
        } else if (stat.isDirectory()) {
            // 是目录，尝试加载index.html
            serveStaticFile(res, path.join(filePath, 'index.html'));
        } else {
            // 是文件，直接服务
            serveStaticFile(res, filePath);
        }
    });
});

// 启动服务器
const PORT = process.env.PORT || 8002;
server.listen(PORT, () => {
    console.log(`静态文件服务器运行在 http://localhost:${PORT}`);
    console.log('静态文件目录:', path.join(__dirname, 'static'));
    console.log('\n文件结构应该是:');
    console.log('├── server.js');
    console.log('└── static/');
    console.log('    ├── index.html');
    console.log('    ├── style.css');
    console.log('    └── script.js');
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n服务器正在关闭...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});
