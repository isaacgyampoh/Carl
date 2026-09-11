import type { ReceiptData } from '@carl/domain';

/**
 * A receipt as it travels between server and browser, or waits on a device.
 *
 * The same data the printer lays out, with the sale's time as an ISO string: a `Date` does not
 * survive being handed from a server component, or being stored on the device.
 */
export type ReceiptSource = Omit<ReceiptData, 'soldAt'> & { soldAt: string };
