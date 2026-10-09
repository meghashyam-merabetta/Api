// Static demo data; replace with common models when implementing persistence.
const items = [
  {
    id: 'demo-user-1',
    name: 'Demo User',
    email: 'demo@example.com',
    active: true,
  },
];

export function listUsers(req, res) {
  const { limit } = req.validatedQuery;
  res.json({ demo: true, data: items.slice(0, limit) });
}
