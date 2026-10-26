import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import type { ExpenseDraft } from '../expense/expenseStore';
import { canEditExpensePlanRow, expensePlanDateKey, expensePlanDateTimestamp,
  type ChatExpensePlanCard as ExpenseCard, type ExpensePlanRow } from './chatExpensePlan';

type Props = {
  card: ExpenseCard;
  busy?: boolean;
  onEditRow: (id: string, patch: Partial<ExpenseDraft>) => void;
  onRemoveRow: (id: string) => void;
  onSave: () => void;
};
const stateLabels: Record<ExpensePlanRow['state'], string> = {
  pending: '待保存', saving: '核对执行结果', saved: '已保存', conflict: '来源版本冲突',
  unknown: '结果待核对', failed: '未保存',
};
const actionLabels: Record<ExpensePlanRow['action'], string> = {
  create: '新增', update: '修改', delete: '删除', refund: '退款',
};

function ExpenseRow({ card, row, index, busy, onEditRow, onRemoveRow, onValidity }: Omit<Props, 'onSave'> & {
  row: ExpensePlanRow; index: number; onValidity: (id: string, valid: boolean) => void;
}) {
  const draft = row.draft ?? row.expected;
  const editable = !busy && canEditExpensePlanRow(card, row);
  const fieldsEditable = editable && row.action !== 'delete';
  const [amount, setAmount] = useState(String(draft?.amount ?? ''));
  const [date, setDate] = useState(draft ? expensePlanDateKey(draft.occurredAt) : '');
  const [error, setError] = useState('');
  const amountValid = (value: string) => /^\d+(?:\.\d{1,2})?$/.test(value)
    && Number.isSafeInteger(Math.round(Number(value) * 100))
    && (Number(value) > 0 || (row.action === 'update' && row.expected?.amount === 0 && Number(value) === 0));
  useEffect(() => { setAmount(String(draft?.amount ?? '')); setDate(draft ? expensePlanDateKey(draft.occurredAt) : ''); setError(''); }, [row.state]);
  useEffect(() => { onValidity(row.id, !fieldsEditable || (!!draft
    && ((row.action === 'update' && !!row.expected && amount === String(row.expected.amount)) || amountValid(amount))
    && expensePlanDateTimestamp(date, draft.occurredAt) !== null)); },
  [amount, date, draft?.occurredAt, fieldsEditable, onValidity, row.id, row.action, row.expected?.amount]);
  if (!draft) return null;
  return (
    <View style={styles.row}>
      <View style={styles.inline}>
        <Text style={styles.rowTitle}>{index + 1} · {actionLabels[row.action]}</Text>
        <Text style={styles.state}>{stateLabels[row.state]}</Text>
      </View>
      {row.expected ? <Text style={styles.source}>原账：{row.expected.category} · {row.expected.amount.toFixed(2)} · {expensePlanDateKey(row.expected.occurredAt)}</Text> : null}
      {row.originalExpected ? <Text style={styles.source}>退款原账：{row.originalExpected.category} · {row.originalExpected.amount.toFixed(2)}</Text> : null}
      <View style={styles.inline}>
        <Text style={styles.label}>金额</Text>
        <TextInput style={[styles.input, styles.amount]} value={amount} editable={fieldsEditable}
          accessibilityLabel={`第${index + 1}笔金额`} keyboardType="decimal-pad"
          onChangeText={value => {
            setAmount(value);
            if (!amountValid(value)) { setError('金额需为正数，最多两位小数'); return; }
            setError(''); onEditRow(row.id, { amount: Number(value) });
          }} />
        {draft.type === 'refund' ? <Text style={styles.value}>退款</Text> : (['expense', 'income'] as const).map(type => (
          <Pressable key={type} style={[styles.choice, draft.type === type && styles.selected]}
            disabled={!fieldsEditable} onPress={() => onEditRow(row.id, { type })}>
            <Text style={styles.value}>{type === 'expense' ? '支出' : '收入'}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.inline}>
        <Text style={styles.label}>日期</Text>
        <TextInput style={[styles.input, styles.date]} value={date} editable={fieldsEditable}
          accessibilityLabel={`第${index + 1}笔日期`} placeholder="YYYY-MM-DD" onChangeText={value => {
            setDate(value);
            const occurredAt = expensePlanDateTimestamp(value, draft.occurredAt);
            if (occurredAt === null) { setError('日期需为有效的 YYYY-MM-DD'); return; }
            setError(''); onEditRow(row.id, { occurredAt });
          }} />
      </View>
      <View style={styles.inline}>
        <Text style={styles.label}>分类</Text>
        <TextInput style={[styles.input, styles.flex]} value={draft.category} editable={fieldsEditable}
          accessibilityLabel={`第${index + 1}笔分类`} onChangeText={category => onEditRow(row.id, { category })} />
      </View>
      <View style={styles.inline}>
        <Text style={styles.label}>备注</Text>
        <TextInput style={[styles.input, styles.flex]} value={draft.note} editable={fieldsEditable} multiline
          accessibilityLabel={`第${index + 1}笔备注`} onChangeText={note => onEditRow(row.id, { note })} />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {row.code && row.state !== 'saved' ? <Text style={styles.error}>状态：{row.code}</Text> : null}
      {editable ? <Pressable style={styles.remove} onPress={() => onRemoveRow(row.id)}>
        <Text style={styles.removeText}>移除这行</Text>
      </Pressable> : null}
    </View>
  );
}

/** Inline original-message card, not a modal or a global chat blocker. */
export function ChatExpensePlanCard(props: Props) {
  const [invalid, setInvalid] = useState<string[]>([]);
  const onValidity = useCallback((id: string, valid: boolean) => setInvalid(previous => valid
    ? previous.filter(item => item !== id) : previous.includes(id) ? previous : [...previous, id]), []);
  const uncertain = props.card.rows.some(row => row.state === 'unknown' || row.state === 'saving');
  const remaining = props.card.rows.some(row => row.state !== 'saved');
  const disabled = !!props.busy || props.card.status !== 'active' || !remaining
    || invalid.some(id => props.card.rows.some(row => row.id === id))
    || (!props.card.feedback.claimed && props.card.feedback.remainingRequests <= 0);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>记账草稿 · {props.card.rows.length} 笔</Text>
      {props.card.status === 'restored' ? <Text style={styles.source}>备份恢复的草稿，仅供查看</Text> : null}
      {props.card.rows.map((row, index) => <ExpenseRow key={row.id} {...props} row={row} index={index} onValidity={onValidity} />)}
      <Pressable style={[styles.save, disabled && styles.disabled]} disabled={disabled} onPress={props.onSave}>
        <Text style={styles.saveText}>{props.busy ? '保存中…' : !props.card.rows.length ? '无待保存行' : uncertain ? '核对未确定结果' : remaining ? '保存未完成行' : '已保存'}</Text>
      </Pressable>
      {!props.card.feedback.claimed && props.card.feedback.remainingRequests <= 0
        ? <Text style={styles.source}>原轮次回复额度不足，不能执行保存</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 8, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: '#DDD1E9', backgroundColor: '#F7F2FB', gap: 8 },
  title: { color: '#514858', fontSize: 15, fontWeight: '600' },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E7E1EF', gap: 7 },
  inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  rowTitle: { flex: 1, color: '#514858', fontWeight: '600' },
  state: { color: '#776580', fontSize: 12 },
  source: { color: '#82768A', fontSize: 12 },
  label: { color: '#73637C', fontSize: 13, minWidth: 30 },
  value: { color: '#514858', fontSize: 13 },
  input: { borderWidth: 1, borderColor: '#D5C9DF', borderRadius: 8, backgroundColor: '#FFFFFF', color: '#514858', paddingHorizontal: 9, paddingVertical: 7, fontSize: 14 },
  amount: { minWidth: 75, maxWidth: 115 }, date: { minWidth: 140 }, flex: { flex: 1, minWidth: 100 },
  choice: { borderWidth: 1, borderColor: '#DDD1E9', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  selected: { backgroundColor: '#E9DFF2' },
  remove: { alignSelf: 'flex-start', paddingVertical: 6 }, removeText: { color: '#9B6475', fontSize: 12 },
  error: { color: '#AB4848', fontSize: 12 },
  save: { alignItems: 'center', borderRadius: 10, paddingVertical: 10, backgroundColor: '#B79CCB' },
  saveText: { color: '#FFFFFF', fontSize: 14 }, disabled: { opacity: 0.5 },
});

