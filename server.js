const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins & headers
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});


// =====================================================
// DATABASE MIGRATION & SCHEMA FIXES
// =====================================================

const initDb = async () => {
    try {

        await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id VARCHAR(255) PRIMARY KEY,
                user_id VARCHAR(255),
                binance_id VARCHAR(255),
                wallet VARCHAR(255),
                amount NUMERIC NOT NULL,
                type VARCHAR(50) DEFAULT 'Binance',
                token_type VARCHAR(50) DEFAULT 'BABYDOGE',
                total_deduct NUMERIC DEFAULT 0,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);


        await pool.query(`
            ALTER TABLE withdrawals 
            ADD COLUMN IF NOT EXISTS user_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS binance_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS wallet VARCHAR(255),
            ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'Binance',
            ADD COLUMN IF NOT EXISTS token_type VARCHAR(50) DEFAULT 'BABYDOGE',
            ADD COLUMN IF NOT EXISTS total_deduct NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

            ALTER TABLE withdrawals ALTER COLUMN user_id DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN binance_id DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN wallet DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN type DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN total_deduct DROP NOT NULL;
        `);

    } catch (err) {

        console.error(
            "Database initialization error:",
            err.message
        );

    }
};



// =====================================================
// ROOT
// =====================================================

app.get('/', (req, res) => {

    res.json({
        status: "Active",
        app: "Crypto Worlds Backend"
    });

});


// =====================================================
// 12. BABYDOGE REWARD + WITHDRAWAL SYSTEM
// =====================================================

const BABYDOGE_REWARD = 500000;
const BABYDOGE_MIN_WITHDRAW = 10000000;
const BABYDOGE_MIN_AD_SECONDS = 8;
const BABYDOGE_ADMIN_PASSWORD = process.env.BABYDOGE_ADMIN_PASSWORD;

const initBabyDogeDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS babydoge_balances (
                user_id VARCHAR(255) PRIMARY KEY,
                balance NUMERIC(40,0) NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS babydoge_ad_sessions (
                id VARCHAR(255) PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                claimed_at TIMESTAMP NULL,
                status VARCHAR(30) NOT NULL DEFAULT 'Pending',
                reward NUMERIC(40,0) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_babydoge_ad_sessions_user
            ON babydoge_ad_sessions(user_id, created_at DESC);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_babydoge_withdrawals
            ON withdrawals(token_type, user_id, created_at DESC);
        `);

        console.log('SUCCESS: BABYDOGE reward system database ready!');
    } catch (err) {
        console.error('BABYDOGE database initialization error:', err.message);
        throw err;
    }
};

function cleanBabyDogeUserId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 255) return null;
    return id;
}

function isValidBinanceUid(value) {
    return /^[0-9]{5,20}$/.test(String(value || '').trim());
}

function getAdminPassword(req) {
    const auth = String(req.headers.authorization || '');
    if (auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    return String(req.body?.password || req.query?.password || '');
}

function requireBabyDogeAdmin(req, res) {
    if (!BABYDOGE_ADMIN_PASSWORD) {
        res.status(503).json({
            success: false,
            message: 'BABYDOGE_ADMIN_PASSWORD is not configured on the server.'
        });
        return false;
    }

    if (getAdminPassword(req) !== BABYDOGE_ADMIN_PASSWORD) {
        res.status(401).json({
            success: false,
            message: 'Invalid admin password.'
        });
        return false;
    }

    return true;
}

// -----------------------------------------------------
// GET BALANCE
// -----------------------------------------------------
app.get('/api/babydoge/balance/:userId', async (req, res) => {
    const userId = cleanBabyDogeUserId(req.params.userId);

    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    try {
        const result = await pool.query(`
            INSERT INTO babydoge_balances (user_id, balance)
            VALUES ($1, 0)
            ON CONFLICT (user_id) DO NOTHING;
        `, [userId]);

        const balanceResult = await pool.query(`
            SELECT balance::TEXT AS balance
            FROM babydoge_balances
            WHERE user_id = $1
        `, [userId]);

        res.json({
            success: true,
            balance: balanceResult.rows[0]?.balance || '0'
        });
    } catch (err) {
        console.error('BABYDOGE balance error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// -----------------------------------------------------
// START AD SESSION
// -----------------------------------------------------
app.post('/api/babydoge/ad/start', async (req, res) => {
    const userId = cleanBabyDogeUserId(req.body.userId);

    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    try {
        // One active pending session per user.
        await pool.query(`
            UPDATE babydoge_ad_sessions
            SET status = 'Cancelled'
            WHERE user_id = $1 AND status = 'Pending'
        `, [userId]);

        const id = randomUUID();

        const result = await pool.query(`
            INSERT INTO babydoge_ad_sessions
            (id, user_id, status, reward)
            VALUES ($1, $2, 'Pending', $3)
            RETURNING id, EXTRACT(EPOCH FROM started_at) * 1000 AS "startedAt";
        `, [id, userId, BABYDOGE_REWARD]);

        res.json({
            success: true,
            sessionId: result.rows[0].id,
            startedAt: Number(result.rows[0].startedAt)
        });
    } catch (err) {
        console.error('BABYDOGE ad start error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// -----------------------------------------------------
// CLAIM AD REWARD
// -----------------------------------------------------
app.post('/api/babydoge/ad/claim', async (req, res) => {
    const userId = cleanBabyDogeUserId(req.body.userId);
    const sessionId = String(req.body.sessionId || '').trim();

    if (!userId || !sessionId) {
        return res.status(400).json({ success: false, message: 'User ID and ad session are required.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const sessionResult = await client.query(`
            SELECT
                id,
                user_id,
                status,
                reward::TEXT AS reward,
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at)) AS elapsed_seconds
            FROM babydoge_ad_sessions
            WHERE id = $1 AND user_id = $2
            FOR UPDATE
        `, [sessionId, userId]);

        if (sessionResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, rewarded: false, message: 'Ad session not found.' });
        }

        const session = sessionResult.rows[0];

        if (session.status !== 'Pending') {
            await client.query('ROLLBACK');
            return res.json({
                success: true,
                rewarded: false,
                message: session.status === 'TooEarly'
                    ? 'This ad was returned before 8 seconds.'
                    : 'This ad session has already been used.'
            });
        }

        const elapsed = Number(session.elapsed_seconds || 0);

        if (elapsed < BABYDOGE_MIN_AD_SECONDS) {
            await client.query(`
                UPDATE babydoge_ad_sessions
                SET status = 'TooEarly', claimed_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [sessionId]);

            await client.query('COMMIT');

            return res.json({
                success: true,
                rewarded: false,
                tooEarly: true,
                elapsedSeconds: Number(elapsed.toFixed(2)),
                requiredSeconds: BABYDOGE_MIN_AD_SECONDS,
                message: `You returned too early. Minimum ${BABYDOGE_MIN_AD_SECONDS} seconds is required. No reward was added.`
            });
        }

        await client.query(`
            INSERT INTO babydoge_balances (user_id, balance)
            VALUES ($1, $2)
            ON CONFLICT (user_id)
            DO UPDATE SET
                balance = babydoge_balances.balance + EXCLUDED.balance,
                updated_at = CURRENT_TIMESTAMP
        `, [userId, session.reward]);

        await client.query(`
            UPDATE babydoge_ad_sessions
            SET status = 'Claimed', claimed_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [sessionId]);

        const balanceResult = await client.query(`
            SELECT balance::TEXT AS balance
            FROM babydoge_balances
            WHERE user_id = $1
        `, [userId]);

        await client.query('COMMIT');

        console.log(`[BABYDOGE AD REWARD] User: ${userId} | Reward: ${BABYDOGE_REWARD}`);

        res.json({
            success: true,
            rewarded: true,
            reward: String(BABYDOGE_REWARD),
            balance: balanceResult.rows[0]?.balance || '0',
            message: `${BABYDOGE_REWARD.toLocaleString()} BABYDOGE added to your balance.`
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('BABYDOGE ad claim error:', err.message);
        res.status(500).json({ success: false, rewarded: false, message: 'Database Error' });
    } finally {
        client.release();
    }
});

// -----------------------------------------------------
// SUBMIT BABYDOGE WITHDRAWAL
// -----------------------------------------------------
app.post('/api/babydoge/withdraw', async (req, res) => {
    const userId = cleanBabyDogeUserId(req.body.userId);
    const binanceId = String(req.body.binanceId || '').trim();
    const amountText = String(req.body.amount || '').trim();

    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    if (!isValidBinanceUid(binanceId)) {
        return res.status(400).json({
            success: false,
            message: 'Only a valid Binance ID is allowed. Enter your numeric Binance UID.'
        });
    }

    if (!/^\d+$/.test(amountText)) {
        return res.status(400).json({ success: false, message: 'Enter a valid withdrawal amount.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const balanceResult = await client.query(`
            SELECT balance::TEXT AS balance
            FROM babydoge_balances
            WHERE user_id = $1
            FOR UPDATE
        `, [userId]);

        const balance = balanceResult.rowCount ? BigInt(balanceResult.rows[0].balance || '0') : 0n;
        const amount = BigInt(amountText);
        const minimum = BigInt(BABYDOGE_MIN_WITHDRAW);

        if (amount < minimum) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `Minimum withdrawal is ${BABYDOGE_MIN_WITHDRAW.toLocaleString()} BABYDOGE.`
            });
        }

        if (amount > balance) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Insufficient BABYDOGE balance.' });
        }

        const id = randomUUID();

        await client.query(`
            UPDATE babydoge_balances
            SET balance = balance - $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2
        `, [amountText, userId]);

        await client.query(`
            INSERT INTO withdrawals
            (
                id,
                user_id,
                binance_id,
                wallet,
                amount,
                type,
                token_type,
                total_deduct,
                status
            )
            VALUES
            ($1, $2, $3, $3, $4, 'Binance', 'BABYDOGE', $4, 'Pending')
        `, [id, userId, binanceId, amountText]);

        const newBalanceResult = await client.query(`
            SELECT balance::TEXT AS balance
            FROM babydoge_balances
            WHERE user_id = $1
        `, [userId]);

        await client.query('COMMIT');

        console.log(`[BABYDOGE WITHDRAWAL] User: ${userId} | Binance: ${binanceId} | Amount: ${amountText}`);

        res.json({
            success: true,
            message: 'Withdrawal request submitted successfully.',
            balance: newBalanceResult.rows[0]?.balance || '0',
            request: {
                id,
                userId,
                binanceId,
                amount: amountText,
                status: 'Pending'
            }
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('BABYDOGE withdrawal error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error' });
    } finally {
        client.release();
    }
});

// -----------------------------------------------------
// USER WITHDRAWAL HISTORY
// -----------------------------------------------------
app.get('/api/babydoge/withdrawals/:userId', async (req, res) => {
    const userId = cleanBabyDogeUserId(req.params.userId);

    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    try {
        const result = await pool.query(`
            SELECT
                id,
                binance_id AS "binanceId",
                amount::TEXT AS amount,
                status,
                created_at AS "createdAt"
            FROM withdrawals
            WHERE user_id = $1
              AND UPPER(token_type) = 'BABYDOGE'
            ORDER BY created_at DESC
            LIMIT 100
        `, [userId]);

        res.json({ success: true, withdrawals: result.rows });
    } catch (err) {
        console.error('BABYDOGE withdrawal history error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// -----------------------------------------------------
// ADMIN: ALL BABYDOGE WITHDRAWALS
// -----------------------------------------------------
app.get('/api/babydoge/admin/withdrawals', async (req, res) => {
    if (!requireBabyDogeAdmin(req, res)) return;

    try {
        const result = await pool.query(`
            SELECT
                id,
                user_id AS "userId",
                binance_id AS "binanceId",
                amount::TEXT AS amount,
                status,
                created_at AS "createdAt"
            FROM withdrawals
            WHERE UPPER(token_type) = 'BABYDOGE'
            ORDER BY created_at DESC
        `);

        res.json({ success: true, withdrawals: result.rows });
    } catch (err) {
        console.error('BABYDOGE admin list error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// -----------------------------------------------------
// ADMIN: APPROVE / REJECT
// -----------------------------------------------------
app.put('/api/babydoge/admin/withdrawals/:id/status', async (req, res) => {
    if (!requireBabyDogeAdmin(req, res)) return;

    const id = String(req.params.id || '').trim();
    const status = String(req.body.status || '').trim();

    if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status must be Approved or Rejected.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(`
            SELECT
                id,
                user_id,
                amount::TEXT AS amount,
                status
            FROM withdrawals
            WHERE id = $1
              AND UPPER(token_type) = 'BABYDOGE'
            FOR UPDATE
        `, [id]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'BABYDOGE withdrawal not found.' });
        }

        const withdrawal = result.rows[0];

        if (withdrawal.status !== 'Pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `This request is already ${withdrawal.status}.`
            });
        }

        if (status === 'Rejected') {
            await client.query(`
                INSERT INTO babydoge_balances (user_id, balance)
                VALUES ($1, $2)
                ON CONFLICT (user_id)
                DO UPDATE SET
                    balance = babydoge_balances.balance + EXCLUDED.balance,
                    updated_at = CURRENT_TIMESTAMP
            `, [withdrawal.user_id, withdrawal.amount]);
        }

        const updateResult = await client.query(`
            UPDATE withdrawals
            SET status = $1
            WHERE id = $2
            RETURNING id, status
        `, [status, id]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: status === 'Rejected'
                ? 'Withdrawal rejected and BABYDOGE refunded to the user.'
                : 'Withdrawal approved successfully.',
            request: updateResult.rows[0]
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('BABYDOGE admin status error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error' });
    } finally {
        client.release();
    }
});

// -----------------------------------------------------
// BABYDOGE ADMIN PANEL
// -----------------------------------------------------
app.get('/admin/babydoge', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crypto Worlds - BABYDOGE Admin</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#090714;color:#fff;font-family:Inter,Arial,sans-serif;padding:20px}.wrap{max-width:1100px;margin:auto}.card{background:linear-gradient(145deg,#171329,#0e0b1b);border:1px solid rgba(255,255,255,.09);border-radius:20px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.35);margin-bottom:18px}h1{margin:0 0 6px;font-size:25px}p{color:#aaa}.row{display:flex;gap:10px;flex-wrap:wrap}input,button{border:0;border-radius:12px;padding:13px 15px;font-size:15px}input{background:#211b36;color:#fff;border:1px solid #39304f;flex:1;min-width:220px}button{background:#8b5cf6;color:white;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.08)}.danger{background:#ef4444}.ok{background:#22c55e}.muted{color:#999;font-size:13px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:13px 10px;border-bottom:1px solid rgba(255,255,255,.08);font-size:14px}th{color:#a78bfa}.status{font-weight:700}.pending{color:#fbbf24}.approved{color:#4ade80}.rejected{color:#f87171}.msg{margin-top:14px;min-height:20px;color:#c4b5fd}.top{display:flex;justify-content:space-between;gap:15px;align-items:center;flex-wrap:wrap}.smallbtn{padding:9px 12px;font-size:13px}.login{max-width:650px;margin:70px auto}
</style>
</head>
<body>
<div class="wrap">
<div class="card login" id="loginCard">
<h1>🟡 Crypto Worlds</h1>
<p>BABYDOGE Withdrawal Admin</p>
<div class="row"><input id="password" type="password" placeholder="Admin password"><button id="loginBtn">Login</button></div>
<div class="msg" id="loginMsg"></div>
</div>
<div id="panel" style="display:none">
<div class="card"><div class="top"><div><h1>💰 BABYDOGE Withdrawals</h1><p>Approve or reject pending withdrawal requests.</p></div><button class="smallbtn" id="refreshBtn">Refresh</button></div><div class="msg" id="panelMsg"></div></div>
<div class="card"><div class="table-wrap"><table><thead><tr><th>Date</th><th>User ID</th><th>Binance ID</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody id="rows"><tr><td colspan="6">No data loaded.</td></tr></tbody></table></div></div>
</div>
</div>
<script>
let adminPassword=sessionStorage.getItem('cw_babydoge_admin_password')||'';
const loginCard=document.getElementById('loginCard');
const panel=document.getElementById('panel');
const loginMsg=document.getElementById('loginMsg');
const panelMsg=document.getElementById('panelMsg');
const rows=document.getElementById('rows');
function authHeaders(){return {'Accept':'application/json','Authorization':'Bearer '+adminPassword,'Content-Type':'application/json'};}
function showPanel(){loginCard.style.display='none';panel.style.display='block';loadRequests();}
async function loadRequests(){
 panelMsg.textContent='Loading...';
 try{
  const r=await fetch('/api/babydoge/admin/withdrawals',{headers:authHeaders()});
  const d=await r.json();
  if(!r.ok||!d.success) throw new Error(d.message||'Failed to load requests');
  rows.innerHTML=d.withdrawals.length?d.withdrawals.map(x=>{
   const status=String(x.status||'Pending');
   const cls=status.toLowerCase();
   const date=x.createdAt?new Date(x.createdAt).toLocaleString():'-';
   const actions=status==='Pending'?'<button class="smallbtn ok" onclick="changeStatus(\\''+x.id+'\\',\\'Approved\\')">Approve</button> <button class="smallbtn danger" onclick="changeStatus(\\''+x.id+'\\',\\'Rejected\\')">Reject</button>':'—';
   return '<tr><td>'+date+'</td><td>'+esc(x.userId)+'</td><td>'+esc(x.binanceId)+'</td><td>'+Number(x.amount).toLocaleString()+'</td><td class="status '+cls+'">'+esc(status)+'</td><td>'+actions+'</td></tr>';
  }).join(''):'<tr><td colspan="6">No BABYDOGE withdrawal requests yet.</td></tr>';
  panelMsg.textContent='';
 }catch(e){panelMsg.textContent=e.message;}
}
async function changeStatus(id,status){
 if(!confirm('Change this request to '+status+'?'))return;
 panelMsg.textContent='Updating...';
 try{
  const r=await fetch('/api/babydoge/admin/withdrawals/'+encodeURIComponent(id)+'/status',{method:'PUT',headers:authHeaders(),body:JSON.stringify({status})});
  const d=await r.json();
  if(!r.ok||!d.success)throw new Error(d.message||'Update failed');
  panelMsg.textContent=d.message||'Updated';
  loadRequests();
 }catch(e){panelMsg.textContent=e.message;}
}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
document.getElementById('loginBtn').onclick=async()=>{
 adminPassword=document.getElementById('password').value;
 loginMsg.textContent='Checking...';
 try{
  const r=await fetch('/api/babydoge/admin/withdrawals',{headers:authHeaders()});
  const d=await r.json();
  if(!r.ok||!d.success)throw new Error(d.message||'Invalid password');
  sessionStorage.setItem('cw_babydoge_admin_password',adminPassword);
  showPanel();
 }catch(e){loginMsg.textContent=e.message;}
};
document.getElementById('refreshBtn').onclick=loadRequests;
if(adminPassword)showPanel();
</script>
</body>
</html>`);
});


// =====================================================
// SERVER START
// =====================================================
// Start the HTTP server only after every required database
// table/index has been created. This prevents the first
// BABYDOGE ad request from arriving before its tables exist.

async function startServer() {
    try {
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL environment variable is missing.');
        }

        await pool.query('SELECT 1');
        await initDb();
        await initBabyDogeDb();

        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            console.log('Database connection verified.');
            console.log('BABYDOGE system ready: 500,000 reward / 8 seconds / 10,000,000 minimum withdrawal.');
        });
    } catch (err) {
        console.error('SERVER STARTUP FAILED:', err.message);
        await pool.end().catch(() => {});
        process.exit(1);
    }
}

startServer();
