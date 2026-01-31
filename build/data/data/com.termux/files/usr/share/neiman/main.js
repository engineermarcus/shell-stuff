import express from 'express';
import { WebSocketServer } from 'ws';
import pkg from '@tobyg74/tiktok-api-dl';
const { Tiktok } = pkg;
import { spawn } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import http from 'http';

const app = express();
const PORT = 3000;
const DOWNLOAD_DIR = './downloads';
const PUBLIC_DIR = './public';

if (!existsSync(DOWNLOAD_DIR)) {
    mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

if (!existsSync(PUBLIC_DIR)) {
    mkdirSync(PUBLIC_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use('/downloads', express.static(DOWNLOAD_DIR));

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store active downloads and processes
const activeDownloads = new Map();
const activeProcesses = new Map();

wss.on('connection', (ws) => {
    console.log('WebSocket client connected');
    
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
    });
});

function broadcastLog(downloadId, type, message) {
    const payload = JSON.stringify({
        downloadId,
        type, // 'info', 'progress', 'success', 'error', 'warning'
        message,
        timestamp: new Date().toISOString()
    });
    
    wss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(payload);
        }
    });
}

// Command execution endpoint - fully async
app.post('/execute', async (req, res) => {
    const { command } = req.body;
    const sessionId = Date.now().toString();
    
    if (!command) {
        return res.status(400).json({ error: 'Command required' });
    }
    
    // Respond immediately to allow concurrent requests
    res.json({ success: true, sessionId });
    
    // Execute asynchronously
    executeCommandAsync(command, sessionId);
});

async function executeCommandAsync(command, sessionId) {
    // Parse command and arguments
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    
    // Command aliases for Termux-style system commands
    const aliases = {
        'system': {
            'install': (pkg) => ['pkg', ['install', '-y', ...pkg]],
            'update': () => ['pkg', ['update']],
            'upgrade': () => ['pkg', ['upgrade', '-y']],
            'remove': (pkg) => ['pkg', ['remove', '-y', ...pkg]]
        }
    };
    
    let execCmd = cmd;
    let execArgs = args;
    
    // Handle system commands
    if (cmd === 'system' && args.length > 0) {
        const subCmd = args[0];
        const subArgs = args.slice(1);
        
        if (aliases.system[subCmd]) {
            const [aliasCmd, aliasArgs] = aliases.system[subCmd](subArgs);
            execCmd = aliasCmd;
            execArgs = aliasArgs;
        } else {
            broadcastLog(sessionId, 'error', `system: unknown command: ${subCmd}`);
            return;
        }
    }
    
    try {
        const childProcess = spawn(execCmd, execArgs, {
            shell: false
        });
        
        // Store process for potential cleanup
        activeProcesses.set(sessionId, childProcess);
        
        let hasOutput = false;
        
        childProcess.stdout.on('data', (data) => {
            hasOutput = true;
            const output = data.toString();
            const lines = output.split('\n').filter(line => line.trim());
            lines.forEach(line => {
                broadcastLog(sessionId, 'info', line);
            });
        });
        
        childProcess.stderr.on('data', (data) => {
            hasOutput = true;
            const output = data.toString();
            const lines = output.split('\n').filter(line => line.trim());
            lines.forEach(line => {
                if (line.toLowerCase().includes('error')) {
                    broadcastLog(sessionId, 'error', line);
                } else if (line.toLowerCase().includes('warning')) {
                    broadcastLog(sessionId, 'warning', line);
                } else {
                    broadcastLog(sessionId, 'info', line);
                }
            });
        });
        
        childProcess.on('close', (code) => {
            activeProcesses.delete(sessionId);
            if (code === 0) {
                if (!hasOutput) {
                    broadcastLog(sessionId, 'success', 'Command completed');
                }
            } else if (code !== null) {
                broadcastLog(sessionId, 'error', `Command exited with code ${code}`);
            }
        });
        
        childProcess.on('error', (err) => {
            activeProcesses.delete(sessionId);
            broadcastLog(sessionId, 'error', `bash: ${cmd}: command not found`);
        });
        
    } catch (error) {
        broadcastLog(sessionId, 'error', error.message);
    }
}

// Search endpoint using yt-dlp - fully async
app.get('/search', async (req, res) => {
    const { q } = req.query;
    
    if (!q) {
        return res.status(400).json({ error: 'Query parameter required' });
    }
    
    try {
        const searchUrl = `ytsearch10:${q}`;
        
        const ytdlp = spawn('yt-dlp', [
            '--dump-json',
            '--flat-playlist',
            searchUrl
        ]);
        
        let output = '';
        let errorOutput = '';
        
        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        ytdlp.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        
        ytdlp.on('close', (code) => {
            if (code !== 0) {
                console.error('Search error:', errorOutput);
                return res.status(500).json({ error: 'Search failed' });
            }
            
            try {
                const lines = output.trim().split('\n').filter(line => line.trim());
                const videos = lines.map(line => {
                    const video = JSON.parse(line);
                    return {
                        title: video.title,
                        url: video.url || `https://youtube.com/watch?v=${video.id}`,
                        thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || '',
                        author: {
                            name: video.uploader || video.channel || 'Unknown'
                        },
                        timestamp: video.duration_string || formatDuration(video.duration),
                        views: video.view_count || 0
                    };
                });
                
                res.json({ videos });
            } catch (parseError) {
                console.error('Parse error:', parseError);
                res.status(500).json({ error: 'Failed to parse search results' });
            }
        });
        
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Download endpoint - fully async, non-blocking
app.get('/download', async (req, res) => {
    const { q, url, format = 'mp4' } = req.query;
    const downloadId = Date.now().toString();
    
    if (!q && !url) {
        return res.status(400).json({ error: 'Query or URL parameter required' });
    }
    
    // Respond immediately to allow concurrent downloads
    res.json({ 
        success: true, 
        downloadId,
        message: 'Download started'
    });
    
    // Process download asynchronously
    if (url?.includes('tiktok')) {
        downloadTikTokAsync(url, downloadId);
    } else {
        downloadYouTubeAsync(q || url, format, downloadId);
    }
});

async function downloadTikTokAsync(url, downloadId) {
    try {
        broadcastLog(downloadId, 'info', 'Fetching TikTok video information...');
        const result = await Tiktok.Downloader(url, { version: 'v3' });
        
        if (result.status !== 'success') {
            broadcastLog(downloadId, 'error', 'Failed to fetch TikTok video');
            return;
        }
        
        const video = result.result;
        const sanitizedTitle = (video.desc || 'tiktok_video').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').substring(0, 100);
        const filename = `${sanitizedTitle}.mp4`;
        const outputPath = path.join(DOWNLOAD_DIR, filename);
        
        broadcastLog(downloadId, 'success', `Title: ${video.desc || 'TikTok Video'}`);
        broadcastLog(downloadId, 'info', `Starting download to: ${filename}`);
        
        const downloadUrl = video.video.noWatermark || video.video[0];
        const args = ['--merge-output-format', 'mp4', '-o', outputPath, downloadUrl];
        const process = spawn('yt-dlp', args);
        
        // Store process
        activeDownloads.set(downloadId, process);
        
        process.stdout.on('data', (data) => {
            const output = data.toString();
            const lines = output.split('\n').filter(line => line.trim());
            lines.forEach(line => {
                if (line.includes('[download]') && line.includes('%')) {
                    broadcastLog(downloadId, 'progress', line.trim());
                } else if (line.trim() && !line.includes('Deleting') && !line.includes('has already been downloaded')) {
                    broadcastLog(downloadId, 'info', line.trim());
                }
            });
        });
        
        process.stderr.on('data', (data) => {
            const output = data.toString();
            const lines = output.split('\n').filter(line => line.trim());
            lines.forEach(line => {
                const lower = line.toLowerCase();
                // Skip harmless warnings
                if (lower.includes('warning') && 
                    (lower.includes('unable to extract') || 
                     lower.includes('assuming') ||
                     lower.includes('certificate') ||
                     lower.includes('falling back'))) {
                    return;
                }
                broadcastLog(downloadId, 'warning', line);
            });
        });
        
        process.on('close', (code) => {
            activeDownloads.delete(downloadId);
            if (code === 0) {
                const possibleExtensions = ['mp4', 'webm', 'mkv'];
                let actualFilename = filename;
                
                for (const ext of possibleExtensions) {
                    const testFilename = `${sanitizedTitle}.${ext}`;
                    const testPath = path.join(DOWNLOAD_DIR, testFilename);
                    if (existsSync(testPath)) {
                        actualFilename = testFilename;
                        break;
                    }
                }
                
                const downloadLink = `http://localhost:${PORT}/downloads/${actualFilename}`;
                broadcastLog(downloadId, 'success', `Download complete! File: ${actualFilename}`);
                broadcastLog(downloadId, 'success', JSON.stringify({
                    downloadUrl: downloadLink,
                    filename: actualFilename,
                    title: video.desc
                }));
            } else {
                broadcastLog(downloadId, 'error', `Download failed with exit code ${code}`);
            }
        });
        
    } catch (error) {
        console.error(`TikTok download error: ${error.message}`);
        broadcastLog(downloadId, 'error', error.message);
    }
}

async function downloadYouTubeAsync(videoUrl, format, downloadId) {
    try {
        broadcastLog(downloadId, 'info', 'Fetching video information...');
        
        const infoProcess = spawn('yt-dlp', ['--dump-json', videoUrl]);
        let infoOutput = '';
        
        infoProcess.stdout.on('data', (data) => {
            infoOutput += data.toString();
        });
        
        infoProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n').filter(line => line.trim());
            lines.forEach(line => {
                broadcastLog(downloadId, 'warning', line);
            });
        });
        
        infoProcess.on('close', (infoCode) => {
            if (infoCode !== 0) {
                broadcastLog(downloadId, 'error', 'Video not found');
                return;
            }
            
            try {
                const videoInfo = JSON.parse(infoOutput);
                const title = videoInfo.title || 'video';
                const thumbnail = videoInfo.thumbnail || videoInfo.thumbnails?.[0]?.url || '';
                const sanitizedTitle = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
                const extension = format.toLowerCase() === 'mp3' ? 'mp3' : 'mp4';
                const filename = `${sanitizedTitle}.${extension}`;
                const outputPath = path.join(DOWNLOAD_DIR, filename);
                
                broadcastLog(downloadId, 'success', `Title: ${title}`);
                broadcastLog(downloadId, 'info', `Format: ${extension.toUpperCase()}`);
                broadcastLog(downloadId, 'info', `Starting download...`);
                
                const args = format.toLowerCase() === 'mp3'
                    ? ['-x', '--audio-format', 'mp3', '-o', outputPath, videoUrl]
                    : ['--merge-output-format', 'mp4', '-o', outputPath, videoUrl];
                
                const downloadProcess = spawn('yt-dlp', args);
                
                // Store process
                activeDownloads.set(downloadId, downloadProcess);
                
                downloadProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    const lines = output.split('\n').filter(line => line.trim());
                    lines.forEach(line => {
                        if (line.includes('[download]') && line.includes('%')) {
                            broadcastLog(downloadId, 'progress', line.trim());
                        } else if (line.includes('[info]') || line.includes('Extracting') || line.includes('Downloading')) {
                            broadcastLog(downloadId, 'info', line.trim());
                        } else if (line.trim() && !line.includes('Deleting') && !line.includes('has already been downloaded')) {
                            broadcastLog(downloadId, 'info', line.trim());
                        }
                    });
                });
                
                downloadProcess.stderr.on('data', (data) => {
                    const output = data.toString();
                    const lines = output.split('\n').filter(line => line.trim());
                    lines.forEach(line => {
                        const lower = line.toLowerCase();
                        // Skip common harmless warnings
                        if (lower.includes('warning') && 
                            (lower.includes('unable to extract') || 
                             lower.includes('assuming') ||
                             lower.includes('certificate') ||
                             lower.includes('falling back') ||
                             lower.includes('requested format'))) {
                            return;
                        }
                        // Only show critical errors
                        if (lower.includes('error') && lower.includes('error:')) {
                            broadcastLog(downloadId, 'error', line);
                        } else if (lower.includes('warning')) {
                            // Skip most warnings
                            return;
                        }
                    });
                });
                
                downloadProcess.on('close', (code) => {
                    activeDownloads.delete(downloadId);
                    if (code === 0) {
                        const possibleExtensions = [extension, 'webm', 'mkv'];
                        let actualFilename = filename;
                        
                        for (const ext of possibleExtensions) {
                            const testFilename = `${sanitizedTitle}.${ext}`;
                            const testPath = path.join(DOWNLOAD_DIR, testFilename);
                            if (existsSync(testPath)) {
                                actualFilename = testFilename;
                                break;
                            }
                        }
                        
                        const downloadUrl = `http://localhost:${PORT}/downloads/${actualFilename}`;
                        broadcastLog(downloadId, 'success', `✓ Download complete! File: ${actualFilename}`);
                        broadcastLog(downloadId, 'success', JSON.stringify({
                            downloadUrl: downloadUrl,
                            filename: actualFilename,
                            title: title,
                            thumbnail: thumbnail
                        }));
                    } else {
                        broadcastLog(downloadId, 'error', `Download failed with exit code ${code}`);
                    }
                });
                
            } catch (parseError) {
                console.error('Parse error:', parseError);
                broadcastLog(downloadId, 'error', 'Failed to parse video info');
            }
        });
        
    } catch (error) {
        console.error(`YouTube download error: ${error.message}`);
        broadcastLog(downloadId, 'error', error.message);
    }
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Cleanup on server shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    
    // Kill all active processes
    activeProcesses.forEach((proc, id) => {
        console.log(`Killing process ${id}`);
        proc.kill();
    });
    
    activeDownloads.forEach((proc, id) => {
        console.log(`Killing download ${id}`);
        proc.kill();
    });
    
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`WebSocket server ready`);
    console.log(`Multi-tasking enabled - concurrent operations supported`);
});