import { qa } from './log.js';
export const isPermissionGranted = async () => true;
export const requestPermission = async () => 'granted';
export const sendNotification = (n) => qa.notifications.push(n);
