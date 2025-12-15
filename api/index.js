const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Serve static files (needed for index.html on Vercel)
app.use(express.static(path.join(__dirname, '..')));

// Simple favicon handler
app.get('/favicon.ico', (req, res) => {
    res.status(204).end(); 
});

// --- AUTH HELPER ---
// This fixes the session disconnect bug by checking Env Vars
const getAuthToken = (req) => {
    // 1. Check Env Var (Best for Vercel)
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    // 2. Check request body (Manual login)
    if (req.body && req.body.token) return req.body.token;
    // 3. Fallback to query param (for image proxy)
    if (req.query && req.query.token) return req.query.token;
    
    return null;
};

// Auth endpoint
app.post('/auth', (req, res) => {
    // Just verifies connectivity now
    const token = getAuthToken(req);
    if (token) {
        res.json({ success: 'Connected via ' + (process.env.GITHUB_TOKEN ? 'Environment Variable' : 'Session') });
    } else {
        res.json({ error: 'No token found. Set GITHUB_TOKEN in Vercel.' });
    }
});

app.post('/test-token', async (req, res) => {
    try {
        const token = getAuthToken(req);
        if (!token) return res.json({ error: 'No token set.' });

        const testResponse = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!testResponse.ok) {
            const errorText = await testResponse.text();
            return res.json({ error: `Token test failed: ${testResponse.status} - ${errorText}` });
        }
        const user = await testResponse.json();
        res.json({ success: `Logged in as: ${user.login}` });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// --- INSTANT IMAGE PROXY (The Fix for Caching) ---
app.get('/og-image.png', async (req, res) => {
    try {
        const token = getAuthToken(req);
        // If you don't have Env Vars set, this proxy won't work publicly
        if (!token) {
            return res.status(401).send('Missing GITHUB_TOKEN env var');
        }

        const filename = req.query.name || 'og-image.png';
        const filePath = `images/${filename}`;

        // Fetch from API, NOT Raw CDN (API is instant)
        const response = await fetch(`https://api.github.com/repos/compusophy/world-world/contents/${filePath}`, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!response.ok) {
            return res.status(404).send('Image not found');
        }

        const data = await response.json();
        
        // GitHub API returns content in base64
        const imgBuffer = Buffer.from(data.content, 'base64');

        // FORCE NO CACHE
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        
        res.send(imgBuffer);

    } catch (error) {
        console.error(error);
        res.status(500).send(error.message);
    }
});

// Upload Image Endpoint
app.post('/upload-image', async (req, res) => {
    try {
        const { content, filename } = req.body; 
        const token = getAuthToken(req);

        if (!token) return res.json({ error: 'GitHub not authenticated' });

        const filePath = `images/${filename}`;

        // 1. Get SHA
        let sha;
        const getResponse = await fetch(`https://api.github.com/repos/compusophy/world-world/contents/${filePath}`, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (getResponse.ok) {
            const currentFile = await getResponse.json();
            sha = currentFile.sha;
        }

        // 2. Upload
        const requestBody = {
            message: `Upload image ${filename}`,
            content: content,
            sha: sha || undefined
        };

        const updateResponse = await fetch(`https://api.github.com/repos/compusophy/world-world/contents/${filePath}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            throw new Error(`GitHub upload failed: ${errorText}`);
        }

        // RETURN THE PROXY URL INSTEAD OF GITHUB RAW
        // This ensures the user gets the instant-update version
        const proxyUrl = `https://world-world.vercel.app/og-image.png?name=${filename}&t=${Date.now()}`;
        
        res.json({ 
            success: 'Image uploaded!', 
            url: proxyUrl 
        });

    } catch (error) {
        console.error(error);
        res.json({ error: error.message });
    }
});

// Commit Text File endpoint
app.post('/commit', async (req, res) => {
    try {
        const { content, filePath, sha } = req.body;
        const token = getAuthToken(req);
        if (!token) return res.json({ error: 'GitHub not authenticated' });

        let currentSha = sha;
        if (!currentSha) {
            const getResponse = await fetch(`https://api.github.com/repos/compusophy/world-world/contents/${encodeURIComponent(filePath || 'index.html')}`, {
                headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
            });
            if (getResponse.ok) {
                const f = await getResponse.json();
                currentSha = f.sha;
            }
        }

        const updateResponse = await fetch(`https://api.github.com/repos/compusophy/world-world/contents/${encodeURIComponent(filePath || 'index.html')}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: `Update ${filePath} from web editor`,
                content: Buffer.from(content).toString('base64'),
                sha: currentSha
            })
        });

        if (!updateResponse.ok) throw new Error(await updateResponse.text());

        res.json({ success: 'Committed successfully!' });

    } catch (error) {
        res.json({ error: error.message });
    }
});

// Create PR endpoint
app.post('/create-pr', async (req, res) => {
    try {
        const { title, body, content, filePath } = req.body;
        const token = getAuthToken(req);
        if (!token) return res.json({ error: 'GitHub not authenticated' });

        const branchName = `web-editor-${Date.now()}`;

        // Get Main Branch
        const mainBranchResponse = await fetch('https://api.github.com/repos/compusophy/world-world/git/ref/heads/main', {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        const mainBranch = await mainBranchResponse.json();

        // Create Branch
        await fetch('https://api.github.com/repos/compusophy/world-world/git/refs', {
            method: 'POST',
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainBranch.object.sha })
        });

        // Get File SHA
        const getFile = await fetch(`https://api.github.com/repos/compusophy/world-world/contents/${encodeURIComponent(filePath || 'index.html')}`, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        const currentFile = getFile.ok ? await getFile.json() : {};

        // Commit
        await fetch(`https://api.github.com/repos/compusophy/world-world/contents/${encodeURIComponent(filePath || 'index.html')}`, {
            method: 'PUT',
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Update from web editor',
                content: Buffer.from(content).toString('base64'),
                sha: currentFile.sha,
                branch: branchName
            })
        });

        // PR
        const prResponse = await fetch('https://api.github.com/repos/compusophy/world-world/pulls', {
            method: 'POST',
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title || 'Update', body: body || '', head: branchName, base: 'main' })
        });

        const pr = await prResponse.json();
        res.json({ success: `PR created: ${pr.html_url}` });

    } catch (error) {
        res.json({ error: error.message });
    }
});

// Merge PR endpoint
app.post('/merge-pr', async (req, res) => {
    try {
        const { prNumber } = req.body;
        const token = getAuthToken(req);
        if (!token) return res.json({ error: 'GitHub not authenticated' });

        const mergeResponse = await fetch(`https://api.github.com/repos/compusophy/world-world/pulls/${prNumber}/merge`, {
            method: 'PUT',
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ commit_title: `Merge PR #${prNumber}`, merge_method: 'merge' })
        });

        if (!mergeResponse.ok) throw new Error(await mergeResponse.text());
        res.json({ success: `PR #${prNumber} merged!` });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// List files
app.get('/files', async (req, res) => {
    try {
        const token = getAuthToken(req);
        if (!token) return res.send('<p>Set GITHUB_TOKEN env var</p>');

        const filesResponse = await fetch('https://api.github.com/repos/compusophy/world-world/contents', {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        
        if (!filesResponse.ok) return res.send(`<p>Error: ${filesResponse.status}</p>`);
        
        const files = await filesResponse.json();
        let html = '<h3>Repository Files</h3>';
        files.forEach(file => {
            const icon = file.type === 'dir' ? '📁' : '📄';
            if (file.type === 'file') {
                 html += `<div style="margin:5px;"><a href="#" onclick="loadFile('${file.path}'); return false;">${icon} ${file.name}</a></div>`;
            } else {
                 html += `<div style="margin:5px;">${icon} ${file.name}/</div>`;
            }
        });
        res.send(html);
    } catch (error) {
        res.send(`<p>Error: ${error.message}</p>`);
    }
});

// Load file
app.get('/file/*', async (req, res) => {
    try {
        const filePath = req.params[0];
        const token = getAuthToken(req);
        if (!token) return res.json({ error: 'GitHub not authenticated' });

        const fileResponse = await fetch(`https://api.github.com/repos/compusophy/world-world/contents/${encodeURIComponent(filePath)}`, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });

        if (!fileResponse.ok) return res.json({ error: 'File not found' });
        
        const fileData = await fileResponse.json();
        res.json({
            content: Buffer.from(fileData.content, 'base64').toString('utf-8'),
            path: filePath,
            sha: fileData.sha
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// List PRs
app.get('/prs', async (req, res) => {
    try {
        const token = getAuthToken(req);
        if (!token) return res.send('<p>Set GITHUB_TOKEN env var</p>');

        const prsResponse = await fetch('https://api.github.com/repos/compusophy/world-world/pulls?state=open', {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        
        const prs = await prsResponse.json();
        if (prs.length === 0) return res.send('<p>No open PRs</p>');

        let html = '<h3>Open PRs</h3>';
        prs.forEach(pr => {
            html += `
                <div style="border:1px solid #ccc; margin:10px; padding:10px;">
                    <h4>PR #${pr.number}: ${pr.title}</h4>
                    <form hx-post="/merge-pr" hx-target="#status" hx-swap="innerHTML">
                        <input type="hidden" name="prNumber" value="${pr.number}">
                        <button type="submit">merge pr</button>
                    </form>
                </div>`;
        });
        res.send(html);
    } catch (error) {
        res.send(`<p>Error: ${error.message}</p>`);
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => console.log(`Running on ${PORT}`));
}
