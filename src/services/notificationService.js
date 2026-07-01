import Notification from '../models/Notification.js';
import ActivityLog from '../models/ActivityLog.js';

export async function createNotification({ userId, title, titleEn, message, messageEn, type = 'info', link, metadata }) {
  return Notification.create({
    user: userId,
    title,
    titleEn,
    message,
    messageEn,
    type,
    link,
    metadata,
  });
}

export async function logActivity({ userId, action, actionEn, entityType, entityId, details }) {
  return ActivityLog.create({
    user: userId,
    action,
    actionEn,
    entityType,
    entityId,
    details,
  });
}

export async function notifyMany(userIds, payload) {
  const unique = [...new Set(userIds.map(String))];
  await Promise.all(unique.map((userId) => createNotification({ userId, ...payload })));
}
