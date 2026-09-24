import { PlannerForm } from './PlannerForm';
import { DgisMapSmoke } from './DgisMapSmoke';

export function App() {
  if (new URLSearchParams(window.location.search).get('map') === '2gis-smoke') return <DgisMapSmoke />;
  return <PlannerForm />;
}
