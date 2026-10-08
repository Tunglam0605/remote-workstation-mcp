import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSocialSchedule, findSocialSemanticField, type SocialSemanticElement } from '../src/web/social-semantic.js';

function element(partial: Partial<SocialSemanticElement> & Pick<SocialSemanticElement,'elementId'|'role'|'name'>): SocialSemanticElement {
  return { visible: true, enabled: true, ...partial };
}

test('YouTube semantic fields prefer exact Vietnamese/English accessible names', () => {
  const elements: SocialSemanticElement[] = [
    element({ elementId:'title', role:'textbox', name:'Tiêu đề (bắt buộc)', value:'BÀI 4 — CAN' }),
    element({ elementId:'desc', role:'textbox', name:'Mô tả', value:'Nội dung bài 4' }),
    element({ elementId:'playlist', role:'button', name:'Danh sách phát' })
  ];
  assert.equal(findSocialSemanticField('youtube', elements, 'title').element?.elementId, 'title');
  assert.equal(findSocialSemanticField('youtube', elements, 'description').element?.elementId, 'desc');
  assert.equal(findSocialSemanticField('youtube', elements, 'playlist').element?.elementId, 'playlist');
});

test('TikTok caption aliases resolve without YouTube-specific selectors', () => {
  const elements: SocialSemanticElement[] = [
    element({ elementId:'caption', role:'textbox', name:'Chú thích', value:'#CANBus' }),
    element({ elementId:'collection', role:'combobox', name:'Bộ sưu tập' })
  ];
  assert.equal(findSocialSemanticField('tiktok', elements, 'description').element?.elementId, 'caption');
  assert.equal(findSocialSemanticField('tiktok', elements, 'playlist').element?.elementId, 'collection');
});

test('schedule audit verifies exact local date and time from semantic value plus visible text', () => {
  const result = auditSocialSchedule({
    platform:'youtube',
    scheduleAt:'2026-10-08T08:00:00+07:00',
    timezone:'Asia/Ho_Chi_Minh',
    text:'Lên lịch 8 thg 10, 2026 Đặt lịch chuyển sang chế độ công khai',
    elements:[element({ elementId:'time', role:'textbox', name:'', value:'08:00' })]
  });
  assert.equal(result.expected.date, '2026-10-08');
  assert.equal(result.expected.time, '08:00');
  assert.equal(result.status.time, 'match');
  assert.equal(result.status.date, 'match');
  assert.equal(result.status.verified, true);
  assert.deepEqual(result.blockers, []);
});

test('schedule audit reports mismatch instead of treating a visible time control as success', () => {
  const result = auditSocialSchedule({
    platform:'youtube',
    scheduleAt:'2026-10-08T08:00:00+07:00',
    timezone:'Asia/Ho_Chi_Minh',
    text:'8 thg 10, 2026',
    elements:[element({ elementId:'time', role:'textbox', name:'', value:'12:00' })]
  });
  assert.equal(result.status.time, 'mismatch');
  assert.equal(result.status.verified, false);
  assert.equal(result.observed.time, '12:00');
});

test('schedule audit fails closed when multiple schedule-time controls are plausible', () => {
  const result = auditSocialSchedule({
    platform:'youtube',
    scheduleAt:'2026-10-08T20:00:00+07:00',
    timezone:'Asia/Ho_Chi_Minh',
    text:'8 thg 10, 2026',
    elements:[
      element({ elementId:'a', role:'textbox', name:'', value:'20:00' }),
      element({ elementId:'b', role:'combobox', name:'', value:'20:00' })
    ]
  });
  assert.equal(result.status.time, 'unknown');
  assert.equal(result.status.verified, false);
  assert.ok(result.blockers.includes('schedule-time-control-ambiguous'));
  assert.ok(result.blockers.includes('schedule-time-value-unavailable'));
});

test('unsupported timezone is rejected before any platform mutation', () => {
  assert.throws(() => auditSocialSchedule({
    platform:'youtube',
    scheduleAt:'2026-10-08T08:00:00+07:00',
    timezone:'Invalid/Zone',
    text:'',
    elements:[]
  }), /Unsupported schedule timezone/);
});
