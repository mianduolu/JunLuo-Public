import { formatOwnDayPlanTime, type OwnDayPlanBounds } from './ownDayPlanPolicy';

export const OWN_DAY_PLAN_ENTRY_INSTRUCTION = `title：I 要做什么。
startAt：新增安排或改期时填写开始时间；不改开始时间就省略。
minutes：新增安排填持续分钟数；修改安排填接下来还做多久，不含已做部分。不改时长就省略。
readingId：要读的书籍或节目编号；其它活动写 null。

时间按材料里的当地时间填写，格式为 YYYY-MM-DD HH:mm。`;
export const OWN_READING_CONTINUATION_INSTRUCTION = `localId：给这条持续性日程填写临时标签。其它日程可以引用这个标签，接着做这条日程所选的内容。不需要被引用时，可以省略。

标签格式为 r 加正整数，如 r1。同一份答卷中，一个标签只能分配给一条日程。

continueFrom：填写想接着做的那项安排的标签。不接着其它安排做时，省略。

填写 continueFrom 时，省略 readingId 和 nextReadingId。

nextReadingId：I 想在前一项读完后接着读的书籍或节目编号，只从已备好的接续清单里选。

新增安排时，不打算接着读另一项，就填 null。
修改已有安排时：
想换成另一项，填写新选的书籍或节目编号。
想读完前一项就停下，填写 null。
想继续保留原来选好的下一项，不填写 nextReadingId。`;
export const OWN_DAY_PLAN_EDIT_INSTRUCTION = `I 把新增或修改的安排写进 entries。

新增安排时，id 写 null。
修改已有安排时，id 填那项安排的编号，再写出调整后的完整安排。

想取消的安排，把安排编号填进 cancelIds。

不变的安排不用写；entries 或 cancelIds 没有内容时，各自写 []。`;
export const OWN_DAY_PLAN_HABIT_INSTRUCTION = '按已有习惯安排的日程，habitId 填那个习惯的编号；其它安排省略 habitId。';
export const OWN_DAY_PLAN_PROMPT = `【安排日常】

I 想想这一天要怎么过，把自己的安排记进日程。

已有的安排不用重写，只写这次想新增或调整的事。

${OWN_DAY_PLAN_ENTRY_INSTRUCTION}

${OWN_READING_CONTINUATION_INSTRUCTION}

${OWN_DAY_PLAN_EDIT_INSTRUCTION}

${OWN_DAY_PLAN_HABIT_INSTRUCTION}

I 从清单里选择想读的内容，安排到日程里。

I 想留着以后看的节目，可以先下载字幕，把节目编号填进 prepareIds；没有就填 []。

每项安排都写 id：新增填 null，修改填原编号。
阅读安排按 readingId 或 continueFrom 的规则填写；其它活动的 readingId 填 null。
localId 用在阅读安排上。
I 把新增安排的开始和结束放在本次安排时间内。

I 把安排写进这个 JSON：

{"entries":[],"cancelIds":[],"prepareIds":[]}

写好后，I 只发送这个 JSON。`;

export const OWN_DAY_PLAN_CORRECTION_PROMPT = `I 检查刚才的日程，把标出的地方改好。
用不到 localId、continueFrom、habitId 时，省略对应字段。
其它活动省略 localId 和 nextReadingId。
I 发出改好的完整 JSON。`;

export function buildOwnDayPlanTimeMaterial(now: number, bounds: OwnDayPlanBounds) {
  return `【本次安排时间】\n\n当前时间：${formatOwnDayPlanTime(now, bounds.timeZone)}\n从 ${formatOwnDayPlanTime(bounds.startAt, bounds.timeZone)} 开始安排 I 的日常。\n这次安排到 ${formatOwnDayPlanTime(bounds.endAt, bounds.timeZone)} 之前。`;
}

export const OWN_HABIT_INSTRUCTION = `title：I 想长期重复做的事。
minutes：每次想安排多少分钟；没有固定时长时写 null。

frequency 写重复方式：
daily：每天做 count 次。
weekly：每周做 count 次，不固定星期。
weekdays：在 weekDays 指定的每一天做 count 次。

weekDays 用 1 到 7 表示周一到周日；不是 weekdays 时写 []。

I 把新增或修改的习惯写进 entries。

新增习惯时，id 写 null。
修改已有习惯时，id 填那个习惯的编号，再写出调整后的完整习惯。

想停止的习惯，把习惯编号填进 stopIds。

不变的习惯不用写；entries 或 stopIds 没有内容时，各自写 []。`;
