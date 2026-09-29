const express = require('express');
const prisma = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');

const router = express.Router();

// GET /api/auth/status — kept for backward compatibility (older frontend
// builds use it to pick a screen). Multi-tenant sign-up no longer depends
// on this: any number of independent businesses can create an account.
router.get('/status', async (req, res) => {
  const count = await prisma.user.count();
  res.json({ hasAccount: count > 0 });
});

// POST /api/auth/signup — creates a new, independent business account.
// Multi-tenant: this can be called any number of times — each call is a
// different business, isolated from every other account's data by userId
// throughout the API. Username just has to be unique.
async function signupHandler(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password should be at least 4 characters.' });
  }
  const passwordHash = await hashPassword(password);
  try {
    const user = await prisma.user.create({
      data: { username: username.trim(), passwordHash },
    });
    const token = signToken(user);
    res.status(201).json({ token, username: user.username });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'That username is already taken. Try another, or log in instead.' });
    }
    throw err;
  }
}
router.post('/signup', signupHandler);
// Alias kept for backward compatibility with older frontend builds.
router.post('/setup', signupHandler);

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = await prisma.user.findFirst({
    where: { username: { equals: username.trim(), mode: 'insensitive' } },
  });
  if (!user) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const token = signToken(user);
  res.json({ token, username: user.username });
});

// PATCH /api/auth/password — change password (requires current password).
router.patch('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'New password should be at least 4 characters.' });
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  res.json({ ok: true });
});

module.exports = router;
