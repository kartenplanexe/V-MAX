import type { PlanningView } from '../shared/planning-form';
import type { ManualChoices } from '../shared/manual-planning';
import type { ActivityChoice } from '../shared/activity-choice';
import { clarificationReview } from '../shared/clarification-review';
import { Action } from './PlannerUi';
import { ActivityPicker } from './ActivityPicker';
import type { ConditionSectionId } from './ConditionsPanel';

export function ClarificationsPanel({ view, busy, edit, resolve, loadActivities, choose }: {
  view: PlanningView; busy: boolean; edit: (section: ConditionSectionId) => void;
  resolve: (id: string) => void; loadActivities: () => Promise<ManualChoices>;
  choose: (dayId: string, activityId: string, choice: ActivityChoice, options: ManualChoices) => void;
}) {
  return <div className="input-clarifications">
    {(view.draft.clarifications ?? []).map(question => {
      const review = clarificationReview(view.draft, question);
      return <article key={question.id} className="input-question">
        <p>Нужно уточнить: «{question.text}»</p>
        {review ? <><p className="field-hint">Сейчас указано: {review.current}</p>
          <div className="choice-list"><Action variant={review.ready ? 'secondary' : 'primary'} disabled={busy} onClick={() => edit(review.section)}>{review.ready ? 'Указать иначе' : 'Указать значение'}</Action>
            {review.ready && <Action disabled={busy} onClick={() => resolve(question.id)}>{review.label}</Action>}</div></>
          : <p className="field-hint">Это условие сохранено, но пока не представлено в доступных полях. Расчёт заблокирован, чтобы не потерять его. Остальные пожелания остаются в черновике.</p>}
      </article>;
    })}
    {view.draft.days.flatMap(day => day.activities.filter(activity => activity.intent_kind !== 'event_visit' &&
      (activity.categories.state !== 'matched' || !activity.categories.include_any.length || view.issues.some(issue => issue.code === 'CATALOG_MISMATCH' && issue.field === `days.${day.day_id}.activities.${activity.id}`))).map(activity =>
      <article key={`${day.day_id}:${activity.id}`} className="input-question"><p>Как подобрать «{activity.label}» на {day.date}?</p>
        <p className="field-hint">Выберите подходящий тип. Порядок и дополнительные условия занятия сохранятся.</p>
        <ActivityPicker disabled={busy} walking={view.draft.shared.mobility?.[0] === 'walking'} triggerLabel="Выбрать тип" replacing load={loadActivities} add={(choice, options) => choose(day.day_id, activity.id, choice, options)} />
      </article>))}
  </div>;
}
