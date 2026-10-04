// העדפות ה-Viewer (נשמרות במכשיר): צבעים, עובי, מילוי, שקיפות וכו'
export const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#111111'];
export const WIDTHS = [2, 3, 5, 8];

const saved = (() => { try { return JSON.parse(localStorage.getItem('vprefs') || '{}'); } catch { return {}; } })();
export const prefs = Object.assign({
  color: '#e53935', fill: null, fillOp: 0.3, op: 1, w: 3, // צורות וקווים
  tcolor: '#e53935', top: 1, tsize: 22,                    // טקסט (tsize = פיקסלים במסך בזמן ההוספה)
  hcolor: '#fdd835', hop: 0.35,                            // הדגשה
  ortho: false, unit: 'm',
}, saved);
prefs.show = Object.assign({ markups: true, measurements: true, links: true }, prefs.show || {});
export const savePrefs = () => { try { localStorage.setItem('vprefs', JSON.stringify(prefs)); } catch { /* ignore */ } };
