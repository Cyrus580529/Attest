import type { PageSnapshot, Risk } from '../types';

export function actionRisk(snapshot: PageSnapshot, actionRefId: string): Risk {
  return snapshot.actions.find((a) => a.ref.id === actionRefId)?.risk ?? 'low';
}

export function isHighRisk(snapshot: PageSnapshot, actionRefId: string): boolean {
  return actionRisk(snapshot, actionRefId) === 'high';
}
