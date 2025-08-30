const http = require('http');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

// 支持的压缩类型
const compressionTypes = ['gzip', 'deflate'];

// MIME类型映射
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.webm': 'audio/webm',
    '.weba': 'audio/webm',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain'
};

// 获取文件的MIME类型
function getMimeType(filePath) {
    const extname = path.extname(filePath).toLowerCase();
    return mimeTypes[extname] || 'application/octet-stream';
}

// 设置CORS响应头（核心修复：添加响应状态检查，避免重复设置）
function setCorsHeaders(res, req) {
    // 关键判断：如果响应已发送（头已发送），直接返回，避免重复设置
    if (res.headersSent) return;

    // 生产环境中应指定具体域名，而不是使用通配符*
    const allowedOrigins = ['https://15db3547.r10.cpolar.top', 'http://localhost:3000'];
    const origin = req.headers.origin;
    
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
}

// 解析请求体
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        const body = [];
        req.on('data', chunk => body.push(chunk))
           .on('end', () => {
               try {
                   resolve(body.length > 0 ? JSON.parse(Buffer.concat(body).toString()) : {});
               } catch (err) {
                   // 非JSON格式的请求体（如表单）直接返回字符串
                   resolve(Buffer.concat(body).toString());
               }
           })
           .on('error', reject);
    });
}

// 处理压缩（修复：压缩前先检查响应头是否已发送）
function handleCompression(req, res, content, mimeType) {
    // 1. 先检查响应头是否已发送，避免后续设置Content-Encoding失败
    if (res.headersSent) return content;

    // 2. 图片等已压缩资源不二次压缩
    const compressibleTypes = /text|application\/(json|javascript|css|svg\+xml)/;
    if (!compressibleTypes.test(mimeType)) {
        return content;
    }

    const acceptEncoding = req.headers['accept-encoding'] || '';
    let compressionMethod = null;

    // 选择最佳压缩方法并设置响应头
    if (acceptEncoding.includes('gzip')) {
        compressionMethod = zlib.createGzip();
        res.setHeader('Content-Encoding', 'gzip');
    } else if (acceptEncoding.includes('deflate')) {
        compressionMethod = zlib.createDeflate();
        res.setHeader('Content-Encoding', 'deflate');
    }

    if (compressionMethod) {
        // 压缩后内容长度变化，移除原Content-Length
        res.removeHeader('Content-Length');
        return content.pipe(compressionMethod);
    }

    return content;
}

// 服务静态文件（修复：调整响应头设置顺序，统一错误处理）
async function serveStaticFile(res, req, filePath) {
    try {
        // 1. 先设置CORS头（确保在所有响应操作前执行）
        setCorsHeaders(res, req);

        // 2. 检查文件是否存在
        await fs.access(filePath);
        
        // 3. 获取文件信息
        const stats = await fs.stat(filePath);
        
        // 4. 设置基础响应头（MIME、缓存、Last-Modified）
        const mimeType = getMimeType(filePath);
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        const lastModified = stats.mtime.toUTCString();
        res.setHeader('Last-Modified', lastModified);

        // 5. 处理缓存命中（304未修改）
        const ifModifiedSince = req.headers['if-modified-since'];
        if (ifModifiedSince === lastModified) {
            res.writeHead(304); // 304响应无响应体，无需设置Content-Length
            res.end();
            return;
        }

        // 6. 非缓存命中：设置Content-Length并发送文件
        res.setHeader('Content-Length', stats.size);
        const fileStream = fsSync.createReadStream(filePath);
        
        // 处理压缩并管道传输（压缩逻辑已做headersSent检查）
        const responseStream = handleCompression(req, res, fileStream, mimeType);
        res.writeHead(200); // 发送200状态码（需在pipe前执行）
        responseStream.pipe(res);
        
    } catch (err) {
        // 错误处理：先设置CORS头（避免重复设置由setCorsHeaders内部判断）
        setCorsHeaders(res, req);

        if (err.code === 'ENOENT') {
            // 文件不存在：404响应
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end(`
                <h1>404 - 页面未找到</h1>
                <p>请求的文件不存在: ${filePath}</p>
                <a href="/">返回首页</a>
            `);
        } else {
            // 服务器错误：500响应
            console.error('文件读取错误:', err);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end('<h1>500 - 服务器内部错误</h1>');
        }
    }
}

// 处理API请求（修复：统一CORS头设置时机）
async function handleApiRequest(req, res, pathname) {
    // 先设置CORS头（确保在响应前执行）
    setCorsHeaders(res, req);
    
    try {
        if (pathname === '/transcribe') {
            const body = await parseRequestBody(req);
            console.log('收到转录请求:', body);
            
            // 发送API响应（无需重复设置CORS头）
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: '转录请求已接收',
                data: {} // 实际项目中替换为真实处理结果
            }));
            return;
        }
        
        // 未找到的API端点：404响应
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: `API端点不存在: ${pathname}`
        }));
        
    } catch (err) {
        // API错误处理：避免重复设置头
        console.error('API处理错误:', err);
        if (res.headersSent) return; // 若头已发送，不再处理
        
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: '服务器处理请求时发生错误'
        }));
    }
}

// 创建服务器（主逻辑：统一错误捕获与CORS头设置）
const server = http.createServer(async (req, res) => {
    try {
        const parsedUrl = url.parse(req.url, true);
        let pathname = decodeURIComponent(parsedUrl.pathname);
        
        console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);
        
        // 1. 处理OPTIONS预检请求（单独处理，避免后续逻辑干扰）
        if (req.method === 'OPTIONS') {
            setCorsHeaders(res, req);
            res.writeHead(204); // 204无内容响应（预检请求无需响应体）
            res.end();
            return;
        }
        
        // 2. 处理API请求
        if (pathname.startsWith('/api/') || pathname === '/transcribe') {
            await handleApiRequest(req, res, pathname);
            return;
        }
        
        // 3. 处理静态文件请求
        // 根路径默认返回index.html
        if (pathname === '/') {
            pathname = '/index.html';
        }
        
        // 构建文件路径并做安全检查（防止目录遍历攻击）
        const staticDir = path.join(__dirname, 'static');
        const filePath = path.join(staticDir, pathname);
        const resolvedPath = path.resolve(filePath);
        
        // 禁止访问static目录外的资源
        if (!resolvedPath.startsWith(staticDir)) {
            setCorsHeaders(res, req);
            res.writeHead(403, { 'Content-Type': 'text/html' });
            res.end('<h1>403 - 禁止访问</h1>');
            return;
        }
        
        // 检查路径是文件还是目录
        try {
            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
                // 目录：尝试加载目录下的index.html
                await serveStaticFile(res, req, path.join(filePath, 'index.html'));
            } else {
                // 文件：直接服务
                await serveStaticFile(res, req, filePath);
            }
        } catch (err) {
            if (err.code === 'ENOENT') {
                // 资源不存在：404响应
                setCorsHeaders(res, req);
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end(`
                    <h1>404 - 页面未找到</h1>
                    <p>请求的资源不存在: ${pathname}</p>
                    <a href="/">返回首页</a>
                `);
            } else {
                throw err; // 其他错误抛给外层捕获
            }
        }
    } catch (err) {
        // 全局错误处理：避免重复设置头
        console.error('服务器错误:', err);
        setCorsHeaders(res, req);
        if (res.headersSent) return;
        
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>500 - 服务器内部错误</h1>');
    }
});

// 启动服务器
const PORT = process.env.PORT || 8002;
server.listen(PORT, () => {
    console.log(`静态文件服务器运行在 http://localhost:${PORT}`);
    console.log('静态文件目录:', path.join(__dirname, 'static'));
    console.log('\n推荐文件结构:');
    console.log('├── server.js（当前文件）');
    console.log('└── static/（静态资源目录）');
    console.log('    ├── index.html（首页）');
    console.log('    ├── css/style.css（样式文件）');
    console.log('    └── js/script.js（脚本文件）');
});

// 优雅关闭（处理Ctrl+C中断）
process.on('SIGINT', () => {
    console.log('\n服务器正在关闭...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});