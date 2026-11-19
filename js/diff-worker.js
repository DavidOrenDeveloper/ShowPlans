/* מנוע ההשוואה (נלקח מאפליקציית MatchPlan ומותאם ל-ShowPlans). רץ ב-Worker כדי לא לתקוע את המסך.
   קלט: מפות "דיו" (0..255) של שתי התוכניות, באותו גודל. פלט: R = דיו שקיים רק בראשונה (A), D = דיו שקיים רק בשנייה (B).
   מעבר להסטה/עובי (tol), האלגוריתם: מאחד פערים בקו מקווקו (gap), מסנן כתמים קטנים (mn), משלים קו שחוצה קו זהה (grow/bridge),
   ומזהה אזורים שבהם צורות שונות חופפות (conflict). */
/* Compare-mode mask computation, off the main thread. Same algorithm as the in-page diffMasks. */
function win(m,W,H,r,e){if(r<1)return m;const v0=e?1:0,n=2*r+1,t=new Uint8Array(W*H),o=new Uint8Array(W*H);
 for(let y=0;y<H;y++){const b=y*W;let c=0;for(let i=-r;i<=r;i++)c+=i<0||i>=W?v0:m[b+i];
  for(let x=0;x<W;x++){t[b+x]=e?(c===n?1:0):(c>0?1:0);const a=x+r+1,q=x-r;c+=(a>=W?v0:m[b+a])-(q<0?v0:m[b+q])}}
 const cnt=new Int32Array(W);for(let x=0;x<W;x++){let c=0;for(let i=-r;i<=r;i++)c+=i<0||i>=H?v0:t[i*W+x];cnt[x]=c}
 for(let y=0;y<H;y++){const b=y*W;for(let x=0;x<W;x++)o[b+x]=e?(cnt[x]===n?1:0):(cnt[x]>0?1:0);
  const a=y+r+1,q=y-r;for(let x=0;x<W;x++)cnt[x]+=(a>=H?v0:t[a*W+x])-(q<0?v0:t[q*W+x])}
 return o}
function despeck(m,W,H,minPx){if(minPx<2)return m;const dm=win(m,W,H,2),seen=new Uint8Array(W*H),st=new Int32Array(W*H),buf=new Int32Array(W*H);
 for(let s0=0;s0<dm.length;s0++){if(!dm[s0]||seen[s0])continue;let sp=0,bn=0,n=0;st[sp++]=s0;seen[s0]=1;
  while(sp){const p=st[--sp];buf[bn++]=p;if(m[p])n++;const x=p%W;
   if(x>0&&dm[p-1]&&!seen[p-1]){seen[p-1]=1;st[sp++]=p-1}if(x<W-1&&dm[p+1]&&!seen[p+1]){seen[p+1]=1;st[sp++]=p+1}
   if(p>=W&&dm[p-W]&&!seen[p-W]){seen[p-W]=1;st[sp++]=p-W}if(p+W<dm.length&&dm[p+W]&&!seen[p+W]){seen[p+W]=1;st[sp++]=p+W}}
  if(n<minPx)for(let i=0;i<bn;i++)m[buf[i]]=0}
 return m}
function dark(c){const W=c.width,H=c.height,d=c.getContext('2d').getImageData(0,0,W,H).data,m=new Uint8Array(W*H);for(let i=0,j=0;j<m.length;i+=4,j++)m[j]=255-((d[i]+d[i+1]+d[i+2])/3|0);return m}
function bin(d){const m=new Uint8Array(d.length);for(let i=0;i<d.length;i++)m[i]=d[i]>20?1:0;return m}
function grow(seed,mask,W,H,n){let c=seed;for(let i=0;i<Math.min(n,12);i++){const d=win(c,W,H,1),o=new Uint8Array(W*H);for(let k=0;k<o.length;k++)o[k]=d[k]&&mask[k]?1:0;c=o}return c}

/* where different shapes overlap (old circle under a new line or text) the shared pixels are not "the same drawing":
   a pixel counts as changed when, around it, both drawings have a lot of ink the other one does not have */
function boxsum(m,W,H,r){const t=new Uint16Array(W*H),o=new Uint16Array(W*H);
 for(let y=0;y<H;y++){const b=y*W;let c=0;for(let i=0;i<=r&&i<W;i++)c+=m[b+i];for(let x=0;x<W;x++){t[b+x]=c;const a=x+r+1,q=x-r;if(a<W)c+=m[b+a];if(q>=0)c-=m[b+q]}}
 const cn=new Int32Array(W);for(let y=0;y<=r&&y<H;y++)for(let x=0;x<W;x++)cn[x]+=t[y*W+x];
 for(let y=0;y<H;y++){for(let x=0;x<W;x++)o[y*W+x]=cn[x];const a=y+r+1,q=y-r;for(let x=0;x<W;x++){if(a<H)cn[x]+=t[a*W+x];if(q>=0)cn[x]-=t[q*W+x]}}
 return o}
function conflict(A,B,Ad,Bd,R,D,W,H,rho){const n=W*H,UA=new Uint8Array(n),UB=new Uint8Array(n);
 for(let i=0;i<n;i++){UA[i]=A[i]&&!Bd[i]?1:0;UB[i]=B[i]&&!Ad[i]?1:0}
 const ua=boxsum(UA,W,H,rho),ub=boxsum(UB,W,H,rho),ta=boxsum(A,W,H,rho),tb=boxsum(B,W,H,rho);
 for(let i=0;i<n;i++){if(R[i]||D[i]||!(A[i]||B[i]))continue;if(ua[i]*4>ta[i]&&ub[i]*4>tb[i]){if(A[i]&&!B[i])R[i]=1;else D[i]=1}}}

function run(m){const{W,H,dA,dB}=m,n=W*H,A=bin(dA),B=bin(dB),f=m.f,s=m.s,r=v=>Math.min(30,Math.round(v*f*s)),g=Math.ceil(r(m.gap)/2),t=Math.max(m.tol>0?1:0,r(m.tol));
 let Ac=A,Bc=B;if(g>0){Ac=win(win(A,W,H,g),W,H,g,1);Bc=win(win(B,W,H,g),W,H,g,1)}
 const Ad=win(Ac,W,H,t),Bd=win(Bc,W,H,t);let R=new Uint8Array(n),D=new Uint8Array(n);
 for(let i=0;i<n;i++){R[i]=A[i]&&!Bd[i]?1:0;D[i]=B[i]&&!Ad[i]?1:0}
 const mn=Math.round(m.mn*f*s*2);despeck(R,W,H,mn);despeck(D,W,H,mn);
 /* a stroke that crosses an unchanged line stays whole: grow real changes back along ink that is not exactly on the other drawing */
 if(t>1){const A1=win(A,W,H,1),B1=win(B,W,H,1),MR=new Uint8Array(n),MD=new Uint8Array(n);for(let i=0;i<n;i++){MR[i]=A[i]&&!B1[i]?1:0;MD[i]=B[i]&&!A1[i]?1:0}R=grow(R,MR,W,H,t);D=grow(D,MD,W,H,t)}
 const bridge=(M,Src)=>{const o=M.slice();for(let y=3;y<H-3;y++)for(let x=3;x<W-3;x++){const i=y*W+x;if(M[i]||!Src[i])continue;if(((M[i-1]||M[i-2]||M[i-3])&&(M[i+1]||M[i+2]||M[i+3]))||((M[i-W]||M[i-2*W]||M[i-3*W])&&(M[i+W]||M[i+2*W]||M[i+3*W])))o[i]=1}return o};
 R=bridge(R,A);D=bridge(D,B);
 conflict(A,B,Ad,Bd,R,D,W,H,Math.min(18,Math.max(5,r(14))));
 return{R,D}}



/* יישור מקומי: מפצה על הבדלי גודל/סיבוב קלים בין התוכניות (למשל סריקה או ייצוא בגודל מעט שונה) שיישור גלובלי אחד לא יכול לתקן.
   מחלקים לתאים, לכל תא מוצאים את ההזזה הקטנה שמתאימה את הקווים של B לאלה של A (בטווח R פיקסלים), מחליקים את שדה ההזזות ומעוותים את B בהתאם.
   תא עם מעט קווים לא מחליט לבד (כדי שאובייקט שהוזז באמת לא "יימשך" ויוסתר) – הוא מקבל את ההזזה של שכניו. */
function pool(m,W,H,f){const w=Math.ceil(W/f),h=Math.ceil(H/f),o=new Uint8Array(w*h);for(let y=0;y<H;y++){const yy=(y/f|0)*w,b=y*W;for(let x=0;x<W;x++)if(m[b+x]>20)o[yy+(x/f|0)]=1}return[o,w,h]}
function localWarp(A,B,W,H,R){
 if(R<2)return B;
 const f=R>=10?4:2,[a,w,h]=pool(A,W,H,f),[b0]=pool(B,W,H,f),b=win(b0,w,h,1),C=Math.round(96/f),nx=Math.ceil(w/C),ny=Math.ceil(h/C),Rd=Math.ceil(R/f)+1,
  SX=new Float32Array(nx*ny).fill(NaN),SY=new Float32Array(nx*ny).fill(NaN);
 const Bs=new Uint8Array(W*H);for(let i=0;i<Bs.length;i++)Bs[i]=B[i]>20?1:0;const Bd=win(Bs,W,H,1);
 for(let cy=0;cy<ny;cy++)for(let cx=0;cx<nx;cx++){
  const x0=cx*C,y0=cy*C,x1=Math.min(w,x0+C),y1=Math.min(h,y0+C),px=[],py=[];
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)if(a[y*w+x]){px.push(x);py.push(y)}
  const n=px.length;if(n<30)continue;
  const st=n>500?Math.ceil(n/500):1;
  const sc=(s,t)=>{let v=0;for(let i=0;i<n;i+=st){const X=px[i]+s,Y=py[i]+t;if(X>=0&&Y>=0&&X<w&&Y<h)v+=b[Y*w+X]}return v};
  let best=-1,bs=0,bt=0;const z=sc(0,0);
  for(let t=-Rd;t<=Rd;t++)for(let s=-Rd;s<=Rd;s++){const v=sc(s,t)-.002*Math.hypot(s,t)*n/st;if(v>best){best=v;bs=s;bt=t}}
  if(best<.5*(n/st)||z>=best*.97){bs=0;bt=0}
  // חידוד ברזולוציה מלאה סביב ההזזה שנמצאה
  const ox=bs*f,oy=bt*f,fx=[],fy=[],S2=Math.max(1,Math.ceil(n*f*f/300));
  for(let i=0;i<n;i+=Math.max(1,Math.ceil(n/60))){const X0=px[i]*f,Y0=py[i]*f;for(let dy=0;dy<f;dy+=S2>2?2:1)for(let dx=0;dx<f;dx+=S2>2?2:1){const X=X0+dx,Y=Y0+dy;if(X<W&&Y<H&&A[Y*W+X]>20){fx.push(X);fy.push(Y)}}}
  let bb=-1,rx=ox,ry=oy;
  for(let t=oy-f;t<=oy+f;t++)for(let s=ox-f;s<=ox+f;s++){let v=0;for(let i=0;i<fx.length;i++){const X=fx[i]+s,Y=fy[i]+t;if(X>=0&&Y>=0&&X<W&&Y<H)v+=Bd[Y*W+X]}v-=.002*Math.hypot(s,t)*fx.length;if(v>bb){bb=v;rx=s;ry=t}}
  SX[cy*nx+cx]=Math.max(-R,Math.min(R,rx));SY[cy*nx+cx]=Math.max(-R,Math.min(R,ry));
 }
 // תאים בלי החלטה: ממוצע השכנים (כמה סבבים), אחרת 0
 for(let pass=0;pass<8;pass++){let ch=false;const nX=SX.slice(),nY=SY.slice();
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const i=y*nx+x;if(!isNaN(SX[i]))continue;let sx=0,sy=0,c=0;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const X=x+dx,Y=y+dy;if(X<0||Y<0||X>=nx||Y>=ny)continue;const j=Y*nx+X;if(!isNaN(SX[j])){sx+=SX[j];sy+=SY[j];c++}}
   if(c){nX[i]=sx/c;nY[i]=sy/c;ch=true}}
  SX.set(nX);SY.set(nY);if(!ch)break}
 for(let i=0;i<SX.length;i++)if(isNaN(SX[i])){SX[i]=0;SY[i]=0}
 // חציון 3x3: מנטרל תאים בודדים שטעו
 const med=(F)=>{const o=F.slice(),t=[];for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){t.length=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const X=x+dx,Y=y+dy;if(X>=0&&Y>=0&&X<nx&&Y<ny)t.push(F[Y*nx+X])}t.sort((p,q)=>p-q);o[y*nx+x]=t[t.length>>1]}return o};
 const MX=med(SX),MY=med(SY),Cf=C*f,Bw=new Uint8Array(W*H);
 for(let y=0;y<H;y++){const gy=Math.max(0,Math.min(ny-1,y/Cf-.5)),y0=Math.floor(gy),y1=Math.min(ny-1,y0+1),ty=gy-y0;
  for(let x=0;x<W;x++){const gx=Math.max(0,Math.min(nx-1,x/Cf-.5)),x0=Math.floor(gx),x1=Math.min(nx-1,x0+1),tx=gx-x0;
   const i00=y0*nx+x0,i10=y0*nx+x1,i01=y1*nx+x0,i11=y1*nx+x1,
    dx=Math.round((MX[i00]*(1-tx)+MX[i10]*tx)*(1-ty)+(MX[i01]*(1-tx)+MX[i11]*tx)*ty),dy=Math.round((MY[i00]*(1-tx)+MY[i10]*tx)*(1-ty)+(MY[i01]*(1-tx)+MY[i11]*tx)*ty),
    X=x+dx,Y=y+dy;if(X>=0&&Y>=0&&X<W&&Y<H)Bw[y*W+x]=B[Y*W+X]}}
 return Bw}

/* קיבוץ הבדלים לאזורים ממוספרים (לרשימת השינויים). f: ביט 1 = רק ב-A, ביט 2 = רק ב-B */
function regions(f,W,H,C){const cw=Math.ceil(W/C),ch=Math.ceil(H/C),g=new Uint8Array(cw*ch);
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const v=f[y*W+x]&3;if(v)g[(y/C|0)*cw+(x/C|0)]|=v}
 const id=new Int32Array(g.length).fill(-1),out=[];
 for(let s=0;s<g.length;s++){if(!g[s]||id[s]>=0)continue;const q=[s];id[s]=out.length;let x0=1e9,y0=1e9,x1=-1,y1=-1,o=0,n=0;
  while(q.length){const c=q.pop(),cx=c%cw,cy=c/cw|0;x0=Math.min(x0,cx);x1=Math.max(x1,cx);y0=Math.min(y0,cy);y1=Math.max(y1,cy);o|=g[c]&1;n|=g[c]>>1&1;
   for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const nx=cx+dx,ny=cy+dy;if(nx<0||ny<0||nx>=cw||ny>=ch)continue;const j=ny*cw+nx;if(g[j]&&id[j]<0){id[j]=out.length;q.push(j)}}}
  out.push({box:[x0*C-6,y0*C-6,(x1-x0+1)*C+12,(y1-y0+1)*C+12],o,n,st:'todo',note:''})}
 const rb=H/20;out.sort((p,q)=>Math.round(p.box[1]/rb)-Math.round(q.box[1]/rb)||q.box[0]-p.box[0]);
 return out}


onmessage=e=>{const m=e.data;try{
  const W=m.W,H=m.H,n=W*H;
  const dB=m.local>=2?localWarp(m.dA,m.dB,W,H,Math.min(40,m.local)):m.dB;
  const r=run({W,H,dA:m.dA,dB,f:1,s:1,gap:m.gap||0,tol:m.tol||0,mn:m.mn||0});
  let regs=null;
  if(m.regs){const f=new Uint8Array(n);for(let i=0;i<n;i++)f[i]=(r.R[i]?1:0)|(r.D[i]?2:0);const C=Math.max(12,Math.round(Math.max(W,H)/150));regs=regions(f,W,H,C)}
  const Bw=m.local>=2?dB:null;
  postMessage({q:m.q,R:r.R,D:r.D,Bw,regs},Bw?[r.R.buffer,r.D.buffer,Bw.buffer]:[r.R.buffer,r.D.buffer])
}catch(x){postMessage({q:e.data.q,err:String(x&&x.message||x)})}};
