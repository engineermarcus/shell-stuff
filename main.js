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

// Store active downloads
const activeDownloads = new Map();

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

// Search endpoint using yt-dlp
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

app.get('/download', async (req, res) => {
    const { q, url, format = 'mp4' } = req.query;
    const downloadId = Date.now().toString();
    
    if (!q && !url) {
        return res.status(400).json({ error: 'Query or URL parameter required' });
    }
    
    try {
        if (url?.includes('tiktok')) {
            broadcastLog(downloadId, 'info', 'Fetching TikTok video information...');
            const result = await Tiktok.Downloader(url, { version: 'v3' });
            
            if (result.status !== 'success') {
                broadcastLog(downloadId, 'error', 'Failed to fetch TikTok video');
                return res.status(400).json({ error: 'Failed to fetch TikTok video' });
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
            
            process.stdout.on('data', (data) => {
                const output = data.toString();
                console.log(output);
                
                // Parse and broadcast all output lines
                const lines = output.split('\n').filter(line => line.trim());
                lines.forEach(line => {
                    if (line.includes('[download]')) {
                        broadcastLog(downloadId, 'progress', line.trim());
                    } else if (line.trim()) {
                        broadcastLog(downloadId, 'info', line.trim());
                    }
                });
            });
            
            process.stderr.on('data', (data) => {
                const output = data.toString();
                console.log(output);
                const lines = output.split('\n').filter(line => line.trim());
                lines.forEach(line => {
                    broadcastLog(downloadId, 'warning', line);
                });
            });
            
            process.on('close', (code) => {
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
                    
                    res.json({ 
                        success: true, 
                        downloadId,
                        title: video.desc,
                        downloadUrl: downloadLink,
                        filename: actualFilename
                    });
                } else {
                    broadcastLog(downloadId, 'error', `Download failed with exit code ${code}`);
                    res.status(500).json({ error: 'Download failed' });
                }
            });
        } else {
            // YouTube download
            const videoUrl = q || url;
            
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
                    return res.status(404).json({ error: 'Video not found' });
                }
                
                try {
                    const videoInfo = JSON.parse(infoOutput);
                    const title = videoInfo.title || 'video';
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
                    
                    downloadProcess.stdout.on('data', (data) => {
                        const output = data.toString();
                        console.log(output);
                        
                        // Parse and broadcast all output lines
                        const lines = output.split('\n').filter(line => line.trim());
                        lines.forEach(line => {
                            if (line.includes('[download]')) {
                                broadcastLog(downloadId, 'progress', line.trim());
                            } else if (line.includes('[info]')) {
                                broadcastLog(downloadId, 'info', line.trim());
                            } else if (line.includes('Extracting') || line.includes('Downloading')) {
                                broadcastLog(downloadId, 'info', line.trim());
                            } else if (line.trim()) {
                                broadcastLog(downloadId, 'info', line.trim());
                            }
                        });
                    });
                    
                    downloadProcess.stderr.on('data', (data) => {
                        const output = data.toString();
                        console.log(output);
                        
                        const lines = output.split('\n').filter(line => line.trim());
                        lines.forEach(line => {
                            if (line.includes('WARNING')) {
                                broadcastLog(downloadId, 'warning', line);
                            } else if (line.includes('ERROR')) {
                                broadcastLog(downloadId, 'error', line);
                            } else if (line.trim()) {
                                broadcastLog(downloadId, 'info', line);
                            }
                        });
                    });
                    
                    downloadProcess.on('close', (code) => {
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
                            
                            res.json({ 
                                success: true,
                                downloadId,
                                title: title,
                                downloadUrl: downloadUrl,
                                filename: actualFilename
                            });
                        } else {
                            broadcastLog(downloadId, 'error', `Download failed with exit code ${code}`);
                            res.status(500).json({ error: 'Download failed' });
                        }
                    });
                    
                } catch (parseError) {
                    console.error('Parse error:', parseError);
                    broadcastLog(downloadId, 'error', 'Failed to parse video info');
                    res.status(500).json({ error: 'Failed to parse video info' });
                }
            });
        }
    } catch (error) {
        console.error(`Error: ${error.message}`);
        broadcastLog(downloadId, 'error', error.message);
        res.status(500).json({ error: error.message });
    }
});

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`WebSocket server ready`);
});