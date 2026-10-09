export { User } from './user.model.js';
export { Session } from './session.model.js';

import { User } from './user.model.js';
import { Session } from './session.model.js';
import {
  Customer,
  CustomerIdentity,
  CustomerOtpChallenge,
  CustomerLoginLog,
  CustomerAddress,
  CustomerFamilyMember,
} from './customer.model.js';
import { Faq, MasterState, MasterCity } from './master.model.js';
import { Lab } from './lab.model.js';
import { AdminProfile } from './admin.model.js';

export const models = {
  lab: Lab,
  user: User,
  session: Session,
  customer: Customer,
  customerIdentity: CustomerIdentity,
  customerOtpChallenge: CustomerOtpChallenge,
  customerLoginLog: CustomerLoginLog,
  customerAddress: CustomerAddress,
  customerFamilyMember: CustomerFamilyMember,
  faq: Faq,
  masterState: MasterState,
  masterCity: MasterCity,
  adminProfile: AdminProfile,
};
