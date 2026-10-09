// Static demo data; replace with common models when implementing persistence.
const items = [
  { id: 1, name: 'Keyboard', price: 1499 },
  { id: 2, name: 'Mouse', price: 799 },
];

export function listProducts(req, res) {
  const { limit } = req.validatedQuery;
  res.json({ demo: true, data: items.slice(0, limit) });
}
