import { randomBytes } from 'node:crypto';

export async function nextOrderId() {
  // 20 alphanumeric characters; the database primary key also enforces uniqueness.
  return 'MB' + randomBytes(9).toString('hex');
}
