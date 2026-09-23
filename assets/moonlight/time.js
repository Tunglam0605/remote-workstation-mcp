export const CONTROL_CENTER_TIME_ZONE = 'Asia/Ho_Chi_Minh';

export function hourInTimeZone(date = new Date(), timeZone = CONTROL_CENTER_TIME_ZONE) {
  const part = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone
  }).formatToParts(date).find((item) => item.type === 'hour');
  const hour = Number(part?.value);
  if (!Number.isInteger(hour)) throw new Error('Unable to resolve local hour for greeting.');
  return hour;
}

export function greetingSource(date = new Date(), timeZone = CONTROL_CENTER_TIME_ZONE) {
  const hour = hourInTimeZone(date, timeZone);
  if (hour >= 5 && hour < 12) return 'Good morning,';
  if (hour >= 12 && hour < 18) return 'Good afternoon,';
  return 'Good evening,';
}
