// Iconos de stem (StemSpec.iconResource).
import icBass from '../assets/icons/ic_bass.png';
import icCrash from '../assets/icons/ic_crash.png';
import icDrums from '../assets/icons/ic_drums.png';
import icGuitar from '../assets/icons/ic_guitar.png';
import icHh from '../assets/icons/ic_hh.png';
import icKick from '../assets/icons/ic_kick.png';
import icOther from '../assets/icons/ic_other.png';
import icPiano from '../assets/icons/ic_piano.png';
import icRide from '../assets/icons/ic_ride.png';
import icSnare from '../assets/icons/ic_snare.png';
import icToms from '../assets/icons/ic_toms.png';
import icVocals from '../assets/icons/ic_vocals.png';
import icVocals1 from '../assets/icons/ic_vocals1.png';
import icVocals2 from '../assets/icons/ic_vocals2.png';
import icWinds from '../assets/icons/ic_winds.png';

export function iconOf(stem: string, hasVocals2: boolean): string {
  if (stem === 'vocals') return hasVocals2 ? icVocals1 : icVocals;
  const m: Record<string, string> = { vocals2: icVocals2, bass: icBass, drums: icDrums, other: icOther, instrumental: icOther,
    piano: icPiano, guitar: icGuitar, winds: icWinds, kick: icKick, snare: icSnare, toms: icToms, hh: icHh, ride: icRide,
    crash: icCrash, perc: icDrums };
  return m[stem] ?? icOther;
}
