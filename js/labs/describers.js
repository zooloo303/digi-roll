// Dispatch using the captured target, never the connected device identity.
import * as dt2 from '../elektron/dt2/pattern.js';
import * as dn2 from '../elektron/dn2/pattern.js';
import { mappedDescriberFor } from '../elektron/legacy-read.js';

export function describerFor(family, requestType, payload) {
  if (requestType !== 0x60) return null;
  if (family === 0x14) return dt2.describeOffset;
  if (family === 0x15) return dn2.describeOffset;
  return mappedDescriberFor(family, requestType, payload);
}
