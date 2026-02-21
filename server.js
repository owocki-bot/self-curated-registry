/**
 * Self-Curated Registry
 * 
 * Projects add themselves to a list - no gatekeeping.
 * Community can upvote/signal support.
 * Filter by support level.
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// Storage
const projects = new Map();     // Projects in registry
const signals = new Map();      // Support signals
const categories = new Set(['public-goods', 'defi', 'nft', 'social', 'infrastructure', 'tooling', 'other']);

// ============================================================================
// API: PROJECTS
// ============================================================================

// Add project to registry (self-register)

// ============================================================================
// WHITELIST MIDDLEWARE
// ============================================================================

let _whitelistCache = null;
let _whitelistCacheTime = 0;
const WHITELIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWhitelist() {
  const now = Date.now();
  if (_whitelistCache && (now - _whitelistCacheTime) < WHITELIST_CACHE_TTL) {
    return _whitelistCache;
  }
  try {
    const res = await fetch('https://www.owockibot.xyz/api/whitelist');
    const data = await res.json();
    _whitelistCache = new Set(data.map(e => (e.address || e).toLowerCase()));
    _whitelistCacheTime = now;
    return _whitelistCache;
  } catch (err) {
    console.error('Whitelist fetch failed:', err.message);
    if (_whitelistCache) return _whitelistCache;
    return new Set();
  }
}

function requireWhitelist(addressField = 'address') {
  return async (req, res, next) => {
    const addr = req.body?.[addressField] || req.body?.creator || req.body?.participant || req.body?.sender || req.body?.from || req.body?.address;
    if (!addr) {
      return res.status(400).json({ error: 'Address required' });
    }
    const whitelist = await fetchWhitelist();
    if (!whitelist.has(addr.toLowerCase())) {
      return res.status(403).json({ error: 'Invite-only. Tag @owockibot on X to request access.' });
    }
    next();
  };
}


app.post('/projects', requireWhitelist(), (req, res) => {
  const { name, description, url, category, owner, logo, tags } = req.body;

  if (!name || !owner) {
    return res.status(400).json({ 
      error: 'name and owner address required',
      example: { 
        name: 'My Project', 
        description: 'A cool thing', 
        url: 'https://...', 
        category: 'public-goods',
        owner: '0x...',
        tags: ['ethereum', 'open-source']
      }
    });
  }

  if (!ethers.isAddress(owner)) {
    return res.status(400).json({ error: 'Invalid owner address' });
  }

  const projectCategory = categories.has(category) ? category : 'other';

  const project = {
    id: uuidv4(),
    name,
    description: description || '',
    url: url || null,
    logo: logo || null,
    category: projectCategory,
    tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
    owner: owner.toLowerCase(),
    supportCount: 0,
    totalSignal: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  projects.set(project.id, project);
  console.log(`[PROJECT ADDED] ${project.id}: ${name} by ${owner.slice(0, 10)}...`);
  
  res.status(201).json(project);
});

// List projects
app.get('/projects', (req, res) => {
  const { category, tag, minSupport, sort, limit, offset } = req.query;
  let results = Array.from(projects.values());

  // Filters
  if (category) {
    results = results.filter(p => p.category === category);
  }
  if (tag) {
    results = results.filter(p => p.tags.includes(tag.toLowerCase()));
  }
  if (minSupport) {
    const min = parseInt(minSupport);
    results = results.filter(p => p.supportCount >= min);
  }

  // Sort
  switch (sort) {
    case 'support':
      results.sort((a, b) => b.supportCount - a.supportCount);
      break;
    case 'signal':
      results.sort((a, b) => b.totalSignal - a.totalSignal);
      break;
    case 'oldest':
      results.sort((a, b) => a.createdAt - b.createdAt);
      break;
    case 'recent':
    default:
      results.sort((a, b) => b.createdAt - a.createdAt);
  }

  // Pagination
  const start = parseInt(offset) || 0;
  const count = Math.min(parseInt(limit) || 50, 100);
  const total = results.length;
  results = results.slice(start, start + count);

  res.json({
    projects: results,
    total,
    offset: start,
    limit: count
  });
});

// Get project details
app.get('/projects/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Get recent supporters
  const projectSignals = Array.from(signals.values())
    .filter(s => s.projectId === project.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);

  res.json({
    ...project,
    recentSupporters: projectSignals
  });
});

// Update project (owner only - trusted for now)
app.put('/projects/:id', requireWhitelist(), (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { name, description, url, category, logo, tags, owner } = req.body;

  // Verify owner (trusted for now - signature verification later)
  if (owner && owner.toLowerCase() !== project.owner) {
    return res.status(403).json({ error: 'Not project owner' });
  }

  if (name) project.name = name;
  if (description !== undefined) project.description = description;
  if (url !== undefined) project.url = url;
  if (logo !== undefined) project.logo = logo;
  if (category && categories.has(category)) project.category = category;
  if (tags && Array.isArray(tags)) project.tags = tags.slice(0, 10);
  project.updatedAt = Date.now();

  projects.set(project.id, project);
  res.json(project);
});

// Delete project (owner only - trusted for now)
app.delete('/projects/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { owner } = req.body;

  if (owner && owner.toLowerCase() !== project.owner) {
    return res.status(403).json({ error: 'Not project owner' });
  }

  projects.delete(project.id);
  
  // Remove signals for this project
  Array.from(signals.entries())
    .filter(([_, s]) => s.projectId === project.id)
    .forEach(([id, _]) => signals.delete(id));

  res.json({ success: true, deleted: project.id });
});

// ============================================================================
// API: SIGNALS (Support)
// ============================================================================

// Signal support for a project
app.post('/projects/:id/signal', requireWhitelist(), (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { address, amount, message } = req.body;

  if (!address) {
    return res.status(400).json({ error: 'address required' });
  }

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  const signalAmount = Math.max(1, Math.min(100, parseInt(amount) || 1));

  // Check if already signaled
  const existing = Array.from(signals.values())
    .find(s => s.projectId === project.id && s.address === address.toLowerCase());

  if (existing) {
    // Update existing signal
    existing.amount += signalAmount;
    existing.message = message || existing.message;
    existing.updatedAt = Date.now();
    signals.set(existing.id, existing);

    project.totalSignal += signalAmount;
    projects.set(project.id, project);

    return res.json({
      signal: existing,
      project: {
        id: project.id,
        name: project.name,
        supportCount: project.supportCount,
        totalSignal: project.totalSignal
      }
    });
  }

  const signal = {
    id: uuidv4(),
    projectId: project.id,
    address: address.toLowerCase(),
    amount: signalAmount,
    message: message || null,
    createdAt: Date.now()
  };

  signals.set(signal.id, signal);

  // Update project stats
  project.supportCount++;
  project.totalSignal += signalAmount;
  projects.set(project.id, project);

  console.log(`[SIGNAL] ${address.slice(0, 10)}... supported ${project.name} with ${signalAmount}`);

  res.status(201).json({
    signal,
    project: {
      id: project.id,
      name: project.name,
      supportCount: project.supportCount,
      totalSignal: project.totalSignal
    }
  });
});

// Remove signal
app.delete('/projects/:id/signal', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { address } = req.body;

  if (!address) {
    return res.status(400).json({ error: 'address required' });
  }

  const existing = Array.from(signals.values())
    .find(s => s.projectId === project.id && s.address === address.toLowerCase());

  if (!existing) {
    return res.status(404).json({ error: 'Signal not found' });
  }

  // Update project stats
  project.supportCount = Math.max(0, project.supportCount - 1);
  project.totalSignal = Math.max(0, project.totalSignal - existing.amount);
  projects.set(project.id, project);

  signals.delete(existing.id);

  res.json({ success: true, removed: existing.id });
});

// Get supporter's signals
app.get('/supporters/:address', (req, res) => {
  const { address } = req.params;

  if (!ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  const addr = address.toLowerCase();
  const supporterSignals = Array.from(signals.values())
    .filter(s => s.address === addr)
    .map(s => {
      const project = projects.get(s.projectId);
      return {
        ...s,
        projectName: project?.name,
        projectCategory: project?.category
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const totalSignal = supporterSignals.reduce((sum, s) => sum + s.amount, 0);

  res.json({
    address: addr,
    projectsSupported: supporterSignals.length,
    totalSignal,
    signals: supporterSignals
  });
});

// ============================================================================
// API: DISCOVERY
// ============================================================================

// Get categories with counts
app.get('/categories', (req, res) => {
  const counts = {};
  categories.forEach(c => counts[c] = 0);
  
  Array.from(projects.values()).forEach(p => {
    counts[p.category] = (counts[p.category] || 0) + 1;
  });

  const result = Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  res.json(result);
});

// Get popular tags
app.get('/tags', (req, res) => {
  const tagCounts = new Map();
  
  Array.from(projects.values()).forEach(p => {
    p.tags.forEach(tag => {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    });
  });

  const result = Array.from(tagCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  res.json(result);
});

// Search projects
app.get('/search', (req, res) => {
  const { q, limit } = req.query;
  
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  const query = q.toLowerCase();
  let results = Array.from(projects.values())
    .filter(p => 
      p.name.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query) ||
      p.tags.some(t => t.includes(query))
    )
    .sort((a, b) => b.supportCount - a.supportCount)
    .slice(0, parseInt(limit) || 20);

  res.json(results);
});

// ============================================================================
// UTILITY
// ============================================================================

app.get('/stats', (req, res) => {
  const allProjects = Array.from(projects.values());
  const allSignals = Array.from(signals.values());
  const totalSignal = allSignals.reduce((sum, s) => sum + s.amount, 0);
  const uniqueSupporters = new Set(allSignals.map(s => s.address)).size;

  res.json({
    totalProjects: allProjects.length,
    totalSignals: allSignals.length,
    totalSignalAmount: totalSignal,
    uniqueSupporters,
    categories: categories.size
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    platform: 'Self-Curated Registry',
    description: 'No gatekeeping - projects add themselves, community signals support',
    features: ['self-registration', 'community signals', 'categories', 'tags', 'search']
  });
});

// Agent endpoint for LLM discovery
app.get('/agent', (req, res) => {
  res.json({
    name: 'Self-Curated Registry',
    description: 'No gatekeeping project registry. Projects add themselves, community signals support. Filter by support level, categories, or tags. No approval process - just self-registration and community curation.',
    network: 'Base (addresses only, no transactions)',
    treasury_fee: 'None - free to use',
    endpoints: [
      { method: 'POST', path: '/projects', description: 'Add project to registry', params: ['name', 'description?', 'url?', 'category?', 'owner', 'logo?', 'tags?'] },
      { method: 'GET', path: '/projects', description: 'List projects', query: ['category?', 'tag?', 'minSupport?', 'sort?', 'limit?', 'offset?'] },
      { method: 'GET', path: '/projects/:id', description: 'Get project details with supporters' },
      { method: 'PUT', path: '/projects/:id', description: 'Update project (owner only)', params: ['owner', 'name?', 'description?', 'url?', 'category?', 'logo?', 'tags?'] },
      { method: 'DELETE', path: '/projects/:id', description: 'Delete project (owner only)', params: ['owner'] },
      { method: 'POST', path: '/projects/:id/signal', description: 'Signal support for project', params: ['address', 'amount? (1-100)', 'message?'] },
      { method: 'DELETE', path: '/projects/:id/signal', description: 'Remove support signal', params: ['address'] },
      { method: 'GET', path: '/supporters/:address', description: 'Get supporter\'s signaled projects' },
      { method: 'GET', path: '/categories', description: 'List categories with counts' },
      { method: 'GET', path: '/tags', description: 'Popular tags' },
      { method: 'GET', path: '/search', description: 'Search projects', query: ['q', 'limit?'] }
    ],
    example_flow: [
      '1. POST /projects - Add "My DeFi Tool" to registry',
      '2. POST /projects/:id/signal - Community members signal support',
      '3. GET /projects?sort=support - Browse by most supported',
      '4. GET /search?q=defi - Search for DeFi projects'
    ],
    x402_enabled: false
  });
});

// Frontend
app.get('/', (req, res) => {
  const allProjects = Array.from(projects.values());
  const topProjects = [...allProjects]
    .sort((a, b) => b.supportCount - a.supportCount)
    .slice(0, 5);

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Self-Curated Registry | No Gatekeeping</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      min-height: 100vh;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem; }
    
    .hero {
      text-align: center;
      padding: 4rem 2rem;
      background: linear-gradient(180deg, rgba(163,113,247,0.15) 0%, transparent 100%);
      border-radius: 16px;
      margin-bottom: 3rem;
    }
    .hero h1 {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      background: linear-gradient(90deg, #a371f7, #58a6ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero p { color: #8b949e; max-width: 600px; margin: 0 auto 2rem; }
    
    .badge {
      display: inline-block;
      background: #238636;
      color: white;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
      margin-bottom: 1rem;
    }
    
    .stats {
      display: flex;
      justify-content: center;
      gap: 3rem;
      margin: 2rem 0;
      flex-wrap: wrap;
    }
    .stat { text-align: center; }
    .stat-value { font-size: 2rem; font-weight: bold; color: #a371f7; }
    .stat-label { color: #8b949e; font-size: 0.85rem; }
    
    .projects {
      background: rgba(163,113,247,0.1);
      border: 1px solid rgba(163,113,247,0.3);
      border-radius: 12px;
      padding: 2rem;
      margin-bottom: 3rem;
    }
    .projects h2 { margin-bottom: 1.5rem; color: #a371f7; }
    .project {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem;
      border-bottom: 1px solid rgba(163,113,247,0.2);
    }
    .project:last-child { border-bottom: none; }
    .project-rank {
      width: 30px;
      height: 30px;
      background: linear-gradient(135deg, #a371f7, #58a6ff);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 0.85rem;
    }
    .project-info { flex: 1; }
    .project-name { font-weight: bold; }
    .project-category { font-size: 0.8rem; color: #8b949e; }
    .project-support { font-weight: bold; color: #a371f7; }
    
    .api-section {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 1.5rem;
    }
    .endpoint {
      display: flex;
      gap: 1rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid #30363d;
      font-family: monospace;
      font-size: 0.85rem;
    }
    .endpoint:last-child { border-bottom: none; }
    .method { width: 60px; }
    .method.get { color: #58a6ff; }
    .method.post { color: #3fb950; }
    .method.put { color: #f0883e; }
    .method.delete { color: #f85149; }
    
    footer {
      text-align: center;
      padding: 2rem;
      color: #8b949e;
      border-top: 1px solid #30363d;
    }
    footer a { color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div class="badge">📋 OPEN REGISTRY</div>
      <h1>📝 Self-Curated Registry</h1>
      <p>No gatekeeping. Projects add themselves. Community signals support. Filter by what matters.</p>
      
      <div class="stats">
        <div class="stat">
          <div class="stat-value">${allProjects.length}</div>
          <div class="stat-label">Projects</div>
        </div>
        <div class="stat">
          <div class="stat-value">${signals.size}</div>
          <div class="stat-label">Signals</div>
        </div>
        <div class="stat">
          <div class="stat-value">${new Set(Array.from(signals.values()).map(s => s.address)).size}</div>
          <div class="stat-label">Supporters</div>
        </div>
      </div>
    </div>

    <div class="projects">
      <h2>🔥 Top Supported Projects</h2>
      ${topProjects.length === 0 ? '<p style="color:#8b949e">No projects yet. Add yours!</p>' : 
        topProjects.map((p, i) => `
        <div class="project">
          <div class="project-rank">${i + 1}</div>
          <div class="project-info">
            <div class="project-name">${p.name}</div>
            <div class="project-category">${p.category}</div>
          </div>
          <div class="project-support">${p.supportCount} supporters</div>
        </div>
      `).join('')}
    </div>

    <div class="api-section">
      <h2 style="margin-bottom: 1rem;">🔌 API</h2>
      <div class="endpoint"><span class="method post">POST</span><span>/projects</span><span style="margin-left:auto;color:#8b949e">Add project</span></div>
      <div class="endpoint"><span class="method get">GET</span><span>/projects</span><span style="margin-left:auto;color:#8b949e">List projects</span></div>
      <div class="endpoint"><span class="method get">GET</span><span>/projects/:id</span><span style="margin-left:auto;color:#8b949e">Project details</span></div>
      <div class="endpoint"><span class="method put">PUT</span><span>/projects/:id</span><span style="margin-left:auto;color:#8b949e">Update project</span></div>
      <div class="endpoint"><span class="method post">POST</span><span>/projects/:id/signal</span><span style="margin-left:auto;color:#8b949e">Signal support</span></div>
      <div class="endpoint"><span class="method get">GET</span><span>/categories</span><span style="margin-left:auto;color:#8b949e">List categories</span></div>
      <div class="endpoint"><span class="method get">GET</span><span>/search?q=</span><span style="margin-left:auto;color:#8b949e">Search</span></div>
    </div>
  </div>

  <footer>
    <p>No fees, no gatekeeping - just community curation 🌱</p>
  </footer>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3013;
app.listen(PORT, () => console.log(`Self-Curated Registry running on :${PORT}`));
module.exports = app;
