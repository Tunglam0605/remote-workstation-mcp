import * as z from 'zod/v4';

export const workspacePathSchema = z.object({
  workspace: z.string().min(1),
  projectPath: z.string().default('.')
});

export const serialDeviceSelectorSchema = z.object({
  deviceId: z.string().min(1).max(512).optional(),
  serialNumber: z.string().min(1).max(256).optional(),
  vendorId: z.string().regex(/^(?:0x)?[A-Fa-f0-9]{4}$/).optional(),
  productId: z.string().regex(/^(?:0x)?[A-Fa-f0-9]{4}$/).optional(),
  manufacturer: z.string().min(1).max(160).optional(),
  nameContains: z.string().min(1).max(160).optional()
}).strict().refine(
  value => Boolean(value.deviceId || value.serialNumber || (value.vendorId && value.productId)),
  { message: 'Serial selector requires deviceId, serialNumber, or both vendorId and productId.' }
);
