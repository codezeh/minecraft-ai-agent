(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))i(s);new MutationObserver(s=>{for(const r of s)if(r.type==="childList")for(const o of r.addedNodes)o.tagName==="LINK"&&o.rel==="modulepreload"&&i(o)}).observe(document,{childList:!0,subtree:!0});function e(s){const r={};return s.integrity&&(r.integrity=s.integrity),s.referrerPolicy&&(r.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?r.credentials="include":s.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function i(s){if(s.ep)return;s.ep=!0;const r=e(s);fetch(s.href,r)}})();/**
* @vue/shared v3.5.44
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/function hc(n){const t=Object.create(null);for(const e of n.split(","))t[e]=1;return e=>e in t}const ce={},Ki=[],Fn=()=>{},rf=()=>!1,Vo=n=>n.charCodeAt(0)===111&&n.charCodeAt(1)===110&&(n.charCodeAt(2)>122||n.charCodeAt(2)<97),Go=n=>n.startsWith("onUpdate:"),we=Object.assign,fc=(n,t)=>{const e=n.indexOf(t);e>-1&&n.splice(e,1)},mp=Object.prototype.hasOwnProperty,te=(n,t)=>mp.call(n,t),Dt=Array.isArray,Ti=n=>Tr(n)==="[object Map]",li=n=>Tr(n)==="[object Set]",su=n=>Tr(n)==="[object Date]",Ht=n=>typeof n=="function",ve=n=>typeof n=="string",zn=n=>typeof n=="symbol",oe=n=>n!==null&&typeof n=="object",of=n=>(oe(n)||Ht(n))&&Ht(n.then)&&Ht(n.catch),af=Object.prototype.toString,Tr=n=>af.call(n),_p=n=>Tr(n).slice(8,-1),lf=n=>Tr(n)==="[object Object]",dc=n=>ve(n)&&n!=="NaN"&&n[0]!=="-"&&""+parseInt(n,10)===n,lr=hc(",key,ref,ref_for,ref_key,onVnodeBeforeMount,onVnodeMounted,onVnodeBeforeUpdate,onVnodeUpdated,onVnodeBeforeUnmount,onVnodeUnmounted"),Wo=n=>{const t=Object.create(null);return(e=>t[e]||(t[e]=n(e)))},gp=/-\w/g,Mn=Wo(n=>n.replace(gp,t=>t.slice(1).toUpperCase())),vp=/\B([A-Z])/g,ss=Wo(n=>n.replace(vp,"-$1").toLowerCase()),cf=Wo(n=>n.charAt(0).toUpperCase()+n.slice(1)),ca=Wo(n=>n?`on${cf(n)}`:""),Ln=(n,t)=>!Object.is(n,t),fo=(n,...t)=>{for(let e=0;e<n.length;e++)n[e](...t)},uf=(n,t,e,i=!1)=>{Object.defineProperty(n,t,{configurable:!0,enumerable:!1,writable:i,value:e})},Xo=n=>{const t=parseFloat(n);return isNaN(t)?n:t};let ru;const qo=()=>ru||(ru=typeof globalThis<"u"?globalThis:typeof self<"u"?self:typeof window<"u"?window:typeof global<"u"?global:{});function Yo(n){if(Dt(n)){const t={};for(let e=0;e<n.length;e++){const i=n[e],s=ve(i)?Sp(i):Yo(i);if(s)for(const r in s)t[r]=s[r]}return t}else if(ve(n)||oe(n))return n}const xp=/;(?![^(]*\))/g,yp=/:([^]+)/,Mp=/"(?:[^"\\]|\\[^])*"|'(?:[^'\\]|\\[^])*'|\\[^]|\/\*[^]*?\*\//g;function Sp(n){const t={};return n.replace(Mp,e=>e.startsWith("/*")?"":e).split(xp).forEach(e=>{if(e){const i=e.split(yp);i.length>1&&(t[i[0].trim()]=i[1].trim())}}),t}function pc(n){let t="";if(ve(n))t=n;else if(Dt(n))for(let e=0;e<n.length;e++){const i=pc(n[e]);i&&(t+=i+" ")}else if(oe(n))for(const e in n)n[e]&&(t+=e+" ");return t.trim()}const Ep="itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,playsinline,readonly",bp=hc(Ep);function hf(n){return!!n||n===""}function Tp(n,t,e){if(n.length!==t.length)return!1;let i=!0;for(let s=0;i&&s<n.length;s++)i=ci(n[s],t[s],e);return i}function ou(n,t,e){if(n.size!==t.size)return!1;const i=Array.from(t),s=new Uint8Array(i.length);for(const r of n){let o=-1;for(let a=0;a<i.length;a++)if(!s[a]&&ci(r,i[a],e)){o=a;break}if(o<0)return!1;s[o]=1}return!0}function Ap(n,t,e){let i=Ti(n),s=Ti(t);if(i||s||(i=li(n),s=li(t),i||s))return i&&s?ou(n,t,e):!1;const r=Object.keys(n).length,o=Object.keys(t).length;if(r!==o)return!1;for(const a in n){const l=n.hasOwnProperty(a),u=t.hasOwnProperty(a);if(l&&!u||!l&&u||!ci(n[a],t[a],e))return!1}return String(n)===String(t)}function au(n,t,e,i){e||(e=[new Map,new Map]);const[s,r]=e;if(s.has(n)||r.has(t))return s.get(n)===t&&r.get(t)===n;s.set(n,t),r.set(t,n);const o=i(n,t,e);return s.delete(n),r.delete(t),o}function ci(n,t,e){if(n===t)return!0;let i=su(n),s=su(t);return i||s?i&&s?n.getTime()===t.getTime():!1:(i=zn(n),s=zn(t),i||s?n===t:(i=Dt(n),s=Dt(t),i||s?i&&s?au(n,t,e,Tp):!1:(i=oe(n),s=oe(t),i||s?!i||!s?!1:au(n,t,e,Ap):String(n)===String(t))))}function mc(n,t){return n.findIndex(e=>ci(e,t))}const ff=n=>!!(n&&n.__v_isRef===!0),en=n=>ve(n)?n:n==null?"":Dt(n)||oe(n)&&(n.toString===af||!Ht(n.toString))?ff(n)?en(n.value):JSON.stringify(n,df,2):String(n),df=(n,t)=>ff(t)?df(n,t.value):Ti(t)?{[`Map(${t.size})`]:[...t.entries()].reduce((e,[i,s],r)=>(e[ua(i,r)+" =>"]=s,e),{})}:li(t)?{[`Set(${t.size})`]:[...t.values()].map(e=>ua(e))}:zn(t)?ua(t):oe(t)&&!Dt(t)&&!lf(t)?String(t):t,ua=(n,t="")=>{var e;return zn(n)?`Symbol(${(e=n.description)!=null?e:t})`:n};/**
* @vue/reactivity v3.5.44
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/let Te;class wp{constructor(t=!1){this.detached=t,this._active=!0,this._on=0,this.effects=[],this.cleanups=[],this._isPaused=!1,this._warnOnRun=!0,this.__v_skip=!0,!t&&Te&&(Te.active?(this.parent=Te,this.index=(Te.scopes||(Te.scopes=[])).push(this)-1):(this._active=!1,this._warnOnRun=!1))}get active(){return this._active}pause(){if(this._active){this._isPaused=!0;let t,e;if(this.scopes){const i=this.scopes.slice();for(t=0,e=i.length;t<e;t++)i[t].pause()}for(t=0,e=this.effects.length;t<e;t++)this.effects[t].pause()}}resume(){if(this._active&&this._isPaused){this._isPaused=!1;let t,e;if(this.scopes){const s=this.scopes.slice();for(t=0,e=s.length;t<e;t++)s[t].resume()}const i=this.effects.slice();for(t=0,e=i.length;t<e;t++)i[t].resume()}}run(t){if(this._active){const e=Te;try{return Te=this,t()}finally{Te=e}}}on(){++this._on===1&&(this.prevScope=Te,Te=this)}off(){if(this._on>0&&--this._on===0){if(Te===this)Te=this.prevScope;else{let t=Te;for(;t;){if(t.prevScope===this){t.prevScope=this.prevScope;break}t=t.prevScope}}this.prevScope=void 0}}stop(t){if(this._active){this._active=!1;let e,i;for(e=0,i=this.effects.length;e<i;e++)this.effects[e].stop();for(this.effects.length=0,e=0,i=this.cleanups.length;e<i;e++)this.cleanups[e]();if(this.cleanups.length=0,this.scopes){const s=this.scopes.slice();for(e=0,i=s.length;e<i;e++)s[e].stop(!0);this.scopes.length=0}if(!this.detached&&this.parent&&!t){const s=this.parent.scopes.pop();s&&s!==this&&(this.parent.scopes[this.index]=s,s.index=this.index)}this.parent=void 0}}}function Rp(){return Te}let de;const ha=new WeakSet;class pf{constructor(t){this.fn=t,this.deps=void 0,this.depsTail=void 0,this.flags=5,this.next=void 0,this.cleanup=void 0,this.scheduler=void 0,Te&&(Te.active?Te.effects.push(this):this.flags&=-2)}pause(){this.flags|=64}resume(){this.flags&64&&(this.flags&=-65,ha.has(this)&&(ha.delete(this),this.trigger()))}notify(){this.flags&2&&!(this.flags&32)||this.flags&8||_f(this)}run(){if(!(this.flags&1))return this.fn();this.flags|=2,lu(this),gf(this);const t=de,e=Sn;de=this,Sn=!0;try{return this.fn()}finally{vf(this),de=t,Sn=e,this.flags&=-3}}stop(){if(this.flags&1){for(let t=this.deps;t;t=t.nextDep)vc(t);this.deps=this.depsTail=void 0,lu(this),this.onStop&&this.onStop(),this.flags&=-2}}trigger(){this.flags&64?ha.add(this):this.scheduler?this.scheduler():this.runIfDirty()}runIfDirty(){sl(this)&&this.run()}get dirty(){return sl(this)}}let mf=0,cr,ur;function _f(n,t=!1){if(n.flags|=8,t){n.next=ur,ur=n;return}n.next=cr,cr=n}function _c(){mf++}function gc(){if(--mf>0)return;if(ur){let t=ur;for(ur=void 0;t;){const e=t.next;t.next=void 0,t.flags&=-9,t=e}}let n;for(;cr;){let t=cr;for(cr=void 0;t;){const e=t.next;if(t.next=void 0,t.flags&=-9,t.flags&1)try{t.trigger()}catch(i){n||(n=i)}t=e}}if(n)throw n}function gf(n){for(let t=n.deps;t;t=t.nextDep)t.version=-1,t.prevActiveLink=t.dep.activeLink,t.dep.activeLink=t}function vf(n){let t,e=n.depsTail,i=e;for(;i;){const s=i.prevDep;i.version===-1?(i===e&&(e=s),vc(i),Cp(i)):t=i,i.dep.activeLink=i.prevActiveLink,i.prevActiveLink=void 0,i=s}n.deps=t,n.depsTail=e}function sl(n){for(let t=n.deps;t;t=t.nextDep)if(t.dep.version!==t.version||t.dep.computed&&(xf(t.dep.computed)||t.dep.version!==t.version))return!0;return!!n._dirty}function xf(n){if(n.flags&4&&!(n.flags&16)||(n.flags&=-17,n.globalVersion===mr)||(n.globalVersion=mr,!n.isSSR&&n.flags&128&&(!n.deps&&!n._dirty||!sl(n))))return;n.flags|=2;const t=n.dep,e=de,i=Sn;de=n,Sn=!0;try{gf(n);const s=n.fn(n._value);(t.version===0||Ln(s,n._value))&&(n.flags|=128,n._value=s,t.version++)}catch(s){throw t.version++,s}finally{de=e,Sn=i,vf(n),n.flags&=-3}}function vc(n,t=!1){const{dep:e,prevSub:i,nextSub:s}=n;if(i&&(i.nextSub=s,n.prevSub=void 0),s&&(s.prevSub=i,n.nextSub=void 0),e.subs===n&&(e.subs=i,!i&&e.computed)){e.computed.flags&=-5;for(let r=e.computed.deps;r;r=r.nextDep)vc(r,!0)}!t&&!--e.sc&&e.map&&e.map.delete(e.key)}function Cp(n){const{prevDep:t,nextDep:e}=n;t&&(t.nextDep=e,n.prevDep=void 0),e&&(e.prevDep=t,n.nextDep=void 0)}let Sn=!0;const yf=[];function kn(){yf.push(Sn),Sn=!1}function Hn(){const n=yf.pop();Sn=n===void 0?!0:n}function lu(n){const{cleanup:t}=n;if(n.cleanup=void 0,t){const e=de;de=void 0;try{t()}finally{de=e}}}let mr=0;class Pp{constructor(t,e){this.sub=t,this.dep=e,this.version=e.version,this.nextDep=this.prevDep=this.nextSub=this.prevSub=this.prevActiveLink=void 0}}class xc{constructor(t){this.computed=t,this.version=0,this.activeLink=void 0,this.subs=void 0,this.map=void 0,this.key=void 0,this.sc=0,this.__v_skip=!0}track(t){if(!de||!Sn||de===this.computed)return;let e=this.activeLink;if(e===void 0||e.sub!==de)e=this.activeLink=new Pp(de,this),de.deps?(e.prevDep=de.depsTail,de.depsTail.nextDep=e,de.depsTail=e):de.deps=de.depsTail=e,Mf(e);else if(e.version===-1&&(e.version=this.version,e.nextDep)){const i=e.nextDep;i.prevDep=e.prevDep,e.prevDep&&(e.prevDep.nextDep=i),e.prevDep=de.depsTail,e.nextDep=void 0,de.depsTail.nextDep=e,de.depsTail=e,de.deps===e&&(de.deps=i)}return e}trigger(t){this.version++,mr++,this.notify(t)}notify(t){_c();try{for(let e=this.subs;e;e=e.prevSub)e.sub.notify()&&e.sub.dep.notify()}finally{gc()}}}function Mf(n){if(n.dep.sc++,n.sub.flags&4){const t=n.dep.computed;if(t&&!n.dep.subs){t.flags|=20;for(let i=t.deps;i;i=i.nextDep)Mf(i)}const e=n.dep.subs;e!==n&&(n.prevSub=e,e&&(e.nextSub=n)),n.dep.subs=n}}const rl=new WeakMap,Ji=Symbol(""),ol=Symbol(""),_r=Symbol("");function De(n,t,e){if(Sn&&de){let i=rl.get(n);i||rl.set(n,i=new Map);let s=i.get(e);s||(i.set(e,s=new xc),s.map=i,s.key=e),s.track()}}function si(n,t,e,i,s,r){const o=rl.get(n);if(!o){mr++;return}const a=l=>{l&&l.trigger()};if(_c(),t==="clear")o.forEach(a);else{const l=Dt(n),u=l&&dc(e);if(l&&e==="length"){const c=Number(i);o.forEach((h,d)=>{(d==="length"||d===_r||!zn(d)&&d>=c)&&a(h)})}else switch((e!==void 0||o.has(void 0))&&a(o.get(e)),u&&a(o.get(_r)),t){case"add":l?u&&a(o.get("length")):(a(o.get(Ji)),Ti(n)&&a(o.get(ol)));break;case"delete":l||(a(o.get(Ji)),Ti(n)&&a(o.get(ol)));break;case"set":Ti(n)&&a(o.get(Ji));break}}gc()}function ls(n){const t=se(n);return t===n||(De(t,"iterate",_r),cn(n))?t:Vn(n)?Ai(n)?t.map(e=>Ci(un(e))):t.map(Ci):t.map(un)}function jo(n){return De(n=se(n),"iterate",_r),n}function Rn(n,t){return Vn(n)?Ci(Ai(n)?un(t):t):un(t)}const Dp={__proto__:null,[Symbol.iterator](){return fa(this,Symbol.iterator,n=>Rn(this,n))},concat(...n){return ls(this).concat(...n.map(t=>Dt(t)?ls(t):t))},entries(){return fa(this,"entries",n=>(n[1]=Rn(this,n[1]),n))},every(n,t){return Kn(this,"every",n,t,void 0,arguments)},filter(n,t){return Kn(this,"filter",n,t,e=>e.map(i=>Rn(this,i)),arguments)},find(n,t){return Kn(this,"find",n,t,e=>Rn(this,e),arguments)},findIndex(n,t){return Kn(this,"findIndex",n,t,void 0,arguments)},findLast(n,t){return Kn(this,"findLast",n,t,e=>Rn(this,e),arguments)},findLastIndex(n,t){return Kn(this,"findLastIndex",n,t,void 0,arguments)},forEach(n,t){return Kn(this,"forEach",n,t,void 0,arguments)},includes(...n){return da(this,"includes",n)},indexOf(...n){return da(this,"indexOf",n)},join(n){return ls(this).join(n)},lastIndexOf(...n){return da(this,"lastIndexOf",n)},map(n,t){return Kn(this,"map",n,t,void 0,arguments)},pop(){return qs(this,"pop")},push(...n){return qs(this,"push",n)},reduce(n,...t){return uu(this,"reduce",n,t)},reduceRight(n,...t){return uu(this,"reduceRight",n,t)},shift(){return qs(this,"shift")},some(n,t){return Kn(this,"some",n,t,void 0,arguments)},splice(...n){return qs(this,"splice",n)},toReversed(){return ls(this).toReversed()},toSorted(n){return ls(this).toSorted(n)},toSpliced(...n){return ls(this).toSpliced(...n)},unshift(...n){return qs(this,"unshift",n)},values(){return fa(this,"values",n=>Rn(this,n))}};function fa(n,t,e){const i=jo(n),s=i[t],r=s.call(i);if(i!==n&&!cn(n)){if(r[Symbol.toStringTag]==="Array Iterator"){const o=Object.create(Object.getPrototypeOf(r));return o.next=()=>cu(r.next(),e),s!==Sf[t]&&Object.defineProperties(o,{return:{get(){const a=r.return;return typeof a=="function"?a.bind(r):a}},throw:{get(){const a=r.throw;return typeof a=="function"?a.bind(r):a}}}),o}r._next=r.next,r.next=()=>cu(r._next(),e)}return r}function cu(n,t){return n.done||(n.value=t(n.value)),n}const Sf=Array.prototype;function Kn(n,t,e,i,s,r){const o=jo(n),a=o!==n&&!cn(n),l=o[t];if(l!==Sf[t]){const h=l.apply(n,r);return a?un(h):h}let u=e;o!==n&&(a?u=function(h,d){return e.call(this,Rn(n,h),d,n)}:e.length>2&&(u=function(h,d){return e.call(this,h,d,n)}));const c=l.call(o,u,i);return a&&s?s(c):c}function uu(n,t,e,i){const s=jo(n),r=s!==n&&!cn(n);let o=e,a=!1;s!==n&&(r?(a=i.length===0,o=function(u,c,h){return a&&(a=!1,u=Rn(n,u)),e.call(this,u,Rn(n,c),h,n)}):e.length>3&&(o=function(u,c,h){return e.call(this,u,c,h,n)}));const l=s[t](o,...i);return a?Rn(n,l):l}function da(n,t,e){const i=se(n);De(i,"iterate",_r);const s=i[t](...e);return(s===-1||s===!1)&&Sc(e[0])?(e[0]=se(e[0]),i[t](...e)):s}function qs(n,t,e=[]){kn(),_c();const i=se(n)[t].apply(n,e);return gc(),Hn(),i}const Lp=hc("__proto__,__v_isRef,__isVue"),Ef=new Set(Object.getOwnPropertyNames(Symbol).filter(n=>n!=="arguments"&&n!=="caller").map(n=>Symbol[n]).filter(zn));function Ip(n){zn(n)||(n=String(n));const t=se(this);return De(t,"has",n),t.hasOwnProperty(n)}class bf{constructor(t=!1,e=!1){this._isReadonly=t,this._isShallow=e}get(t,e,i){if(e==="__v_skip")return t.__v_skip;const s=this._isReadonly,r=this._isShallow;if(e==="__v_isReactive")return!s;if(e==="__v_isReadonly")return s;if(e==="__v_isShallow")return r;if(e==="__v_raw")return i===(s?r?Gp:Rf:r?wf:Af).get(t)||Object.getPrototypeOf(t)===Object.getPrototypeOf(i)?t:void 0;const o=Dt(t);if(!s){let l;if(o&&(l=Dp[e]))return l;if(e==="hasOwnProperty")return Ip}const a=Reflect.get(t,e,Le(t)?t:i);if((zn(e)?Ef.has(e):Lp(e))||(s||De(t,"get",e),r))return a;if(Le(a)){const l=o&&dc(e)?a:a.value;return s&&oe(l)?ll(l):l}return oe(a)?s?ll(a):Ar(a):a}}class Tf extends bf{constructor(t=!1){super(!1,t)}set(t,e,i,s){let r=t[e];const o=Dt(t)&&dc(e);if(!this._isShallow){const u=Vn(r);if(!cn(i)&&!Vn(i)&&(r=se(r),i=se(i)),!o&&Le(r)&&!Le(i))return u||(r.value=i),!0}const a=o?Number(e)<t.length:te(t,e),l=Reflect.set(t,e,i,Le(t)?t:s);return t===se(s)&&l&&(a?Ln(i,r)&&si(t,"set",e,i):si(t,"add",e,i)),l}deleteProperty(t,e){const i=te(t,e);t[e];const s=Reflect.deleteProperty(t,e);return s&&i&&si(t,"delete",e,void 0),s}has(t,e){const i=Reflect.has(t,e);return(!zn(e)||!Ef.has(e))&&De(t,"has",e),i}ownKeys(t){return De(t,"iterate",Dt(t)?"length":Ji),Reflect.ownKeys(t)}}class Up extends bf{constructor(t=!1){super(!0,t)}set(t,e){return!0}deleteProperty(t,e){return!0}}const Np=new Tf,Op=new Up,Fp=new Tf(!0);const al=n=>n,Nr=n=>Reflect.getPrototypeOf(n);function Bp(n,t,e){return function(...i){const s=this.__v_raw,r=se(s),o=Ti(r),a=n==="entries"||n===Symbol.iterator&&o,l=n==="keys"&&o,u=s[n](...i),c=e?al:t?Ci:un;return!t&&De(r,"iterate",l?ol:Ji),we(Object.create(u),{next(){const{value:h,done:d}=u.next();return d?{value:h,done:d}:{value:a?[c(h[0]),c(h[1])]:c(h),done:d}}})}}function Or(n){return function(...t){return n==="delete"?!1:n==="clear"?void 0:this}}function zp(n,t){const e={get(s){const r=this.__v_raw,o=se(r),a=se(s);n||(Ln(s,a)&&De(o,"get",s),De(o,"get",a));const{has:l}=Nr(o),u=t?al:n?Ci:un;if(l.call(o,s))return u(r.get(s));if(l.call(o,a))return u(r.get(a));r!==o&&r.get(s)},get size(){const s=this.__v_raw;return!n&&De(se(s),"iterate",Ji),s.size},has(s){const r=this.__v_raw,o=se(r),a=se(s);return n||(Ln(s,a)&&De(o,"has",s),De(o,"has",a)),s===a?r.has(s):r.has(s)||r.has(a)},forEach(s,r){const o=this,a=o.__v_raw,l=se(a),u=t?al:n?Ci:un;return!n&&De(l,"iterate",Ji),a.forEach((c,h)=>s.call(r,u(c),u(h),o))}};return we(e,n?{add:Or("add"),set:Or("set"),delete:Or("delete"),clear:Or("clear")}:{add(s){const r=se(this),o=Nr(r),a=se(s),l=!t&&!cn(s)&&!Vn(s)?a:s;return o.has.call(r,l)||Ln(s,l)&&o.has.call(r,s)||Ln(a,l)&&o.has.call(r,a)||(r.add(l),si(r,"add",l,l)),this},set(s,r){!t&&!cn(r)&&!Vn(r)&&(r=se(r));const o=se(this),{has:a,get:l}=Nr(o);let u=a.call(o,s);u||(s=se(s),u=a.call(o,s));const c=l.call(o,s);return o.set(s,r),u?Ln(r,c)&&si(o,"set",s,r):si(o,"add",s,r),this},delete(s){const r=se(this),{has:o,get:a}=Nr(r);let l=o.call(r,s);l||(s=se(s),l=o.call(r,s)),a&&a.call(r,s);const u=r.delete(s);return l&&si(r,"delete",s,void 0),u},clear(){const s=se(this),r=s.size!==0,o=s.clear();return r&&si(s,"clear",void 0,void 0),o}}),["keys","values","entries",Symbol.iterator].forEach(s=>{e[s]=Bp(s,n,t)}),e}function yc(n,t){const e=zp(n,t);return(i,s,r)=>s==="__v_isReactive"?!n:s==="__v_isReadonly"?n:s==="__v_isShallow"?t:s==="__v_raw"?i:Reflect.get(te(e,s)&&s in i?e:i,s,r)}const kp={get:yc(!1,!1)},Hp={get:yc(!1,!0)},Vp={get:yc(!0,!1)};const Af=new WeakMap,wf=new WeakMap,Rf=new WeakMap,Gp=new WeakMap;function Wp(n){switch(n){case"Object":case"Array":return 1;case"Map":case"Set":case"WeakMap":case"WeakSet":return 2;default:return 0}}function Ar(n){return Vn(n)?n:Mc(n,!1,Np,kp,Af)}function Xp(n){return Mc(n,!1,Fp,Hp,wf)}function ll(n){return Mc(n,!0,Op,Vp,Rf)}function Mc(n,t,e,i,s){if(!oe(n)||n.__v_raw&&!(t&&n.__v_isReactive)||n.__v_skip||!Object.isExtensible(n))return n;const r=s.get(n);if(r)return r;const o=Wp(_p(n));if(o===0)return n;const a=new Proxy(n,o===2?i:e);return s.set(n,a),a}function Ai(n){return Vn(n)?Ai(n.__v_raw):!!(n&&n.__v_isReactive)}function Vn(n){return!!(n&&n.__v_isReadonly)}function cn(n){return!!(n&&n.__v_isShallow)}function Sc(n){return n?!!n.__v_raw:!1}function se(n){const t=n&&n.__v_raw;return t?se(t):n}function qp(n){return!te(n,"__v_skip")&&Object.isExtensible(n)&&uf(n,"__v_skip",!0),n}const un=n=>oe(n)?Ar(n):n,Ci=n=>oe(n)?ll(n):n;function Le(n){return n?n.__v_isRef===!0:!1}function gr(n){return Yp(n,!1)}function Yp(n,t){return Le(n)?n:new jp(n,t)}class jp{constructor(t,e){this.dep=new xc,this.__v_isRef=!0,this.__v_isShallow=!1,this._rawValue=e?t:se(t),this._value=e?t:un(t),this.__v_isShallow=e}get value(){return this.dep.track(),this._value}set value(t){const e=this._rawValue,i=this.__v_isShallow||cn(t)||Vn(t);t=i?t:se(t),Ln(t,e)&&(this._rawValue=t,this._value=i?t:un(t),this.dep.trigger())}}function jt(n){return Le(n)?n.value:n}const Kp={get:(n,t,e)=>t==="__v_raw"?n:jt(Reflect.get(n,t,e)),set:(n,t,e,i)=>{const s=n[t];return Le(s)&&!Le(e)?(s.value=e,!0):Reflect.set(n,t,e,i)}};function Cf(n){return Ai(n)?n:new Proxy(n,Kp)}class $p{constructor(t,e,i){this.fn=t,this.setter=e,this._value=void 0,this.dep=new xc(this),this.__v_isRef=!0,this.deps=void 0,this.depsTail=void 0,this.flags=16,this.globalVersion=mr-1,this.next=void 0,this.effect=this,this.__v_isReadonly=!e,this.isSSR=i}notify(){if(this.flags|=16,!(this.flags&8)&&de!==this)return _f(this,!0),!0}get value(){const t=this.dep.track();return xf(this),t&&(t.version=this.dep.version),this._value}set value(t){this.setter&&this.setter(t)}}function Zp(n,t,e=!1){let i,s;return Ht(n)?i=n:(i=n.get,s=n.set),new $p(i,s,e)}const Fr={},Co=new WeakMap;let Gi;function Jp(n,t=!1,e=Gi){if(e){let i=Co.get(e);i||Co.set(e,i=[]),i.push(n)}}function Qp(n,t,e=ce){const{immediate:i,deep:s,once:r,scheduler:o,augmentJob:a,call:l}=e,u=x=>s?x:cn(x)||s===!1||s===0?ri(x,1):ri(x);let c,h,d,p,g=!1,v=!1;if(Le(n)?(h=()=>n.value,g=cn(n)):Ai(n)?(h=()=>u(n),g=!0):Dt(n)?(v=!0,g=n.some(x=>Ai(x)||cn(x)),h=()=>n.map(x=>{if(Le(x))return x.value;if(Ai(x))return u(x);if(Ht(x))return l?l(x,2):x()})):Ht(n)?t?h=l?()=>l(n,2):n:h=()=>{if(d){kn();try{d()}finally{Hn()}}const x=Gi;Gi=c;try{return l?l(n,3,[p]):n(p)}finally{Gi=x}}:h=Fn,t&&s){const x=h,B=s===!0?1/0:s;h=()=>ri(x(),B)}const m=Rp(),f=()=>{c.stop(),m&&m.active&&fc(m.effects,c)};if(r&&t){const x=t;t=(...B)=>{try{return x(...B)}finally{f()}}}let w=v?new Array(n.length).fill(Fr):Fr;const b=x=>{if(!(!(c.flags&1)||!c.dirty&&!x))if(t){const B=c.run();if(x||s||g||(v?B.some((P,D)=>Ln(P,w[D])):Ln(B,w))){const P=Gi;kn();try{d&&d(),Gi=c;const D=[B,w===Fr?void 0:v&&w[0]===Fr?[]:w,p];w=B,l?l(t,3,D):t(...D)}finally{Gi=P,Hn()}}}else c.run()};return a&&a(b),c=new pf(h),c.scheduler=o?()=>o(b,!1):b,p=x=>Jp(x,!1,c),d=c.onStop=()=>{const x=Co.get(c);if(x){if(l)l(x,4);else for(const B of x)B();Co.delete(c)}},t?i?b(!0):w=c.run():o?o(b.bind(null,!0),!0):c.run(),f.pause=c.pause.bind(c),f.resume=c.resume.bind(c),f.stop=f,f}function ri(n,t=1/0,e){if(t<=0||!oe(n)||n.__v_skip||(e=e||new Map,(e.get(n)||0)>=t))return n;if(e.set(n,t),t--,Le(n))ri(n.value,t,e);else if(Dt(n))for(let i=0;i<n.length;i++)ri(n[i],t,e);else if(li(n)||Ti(n))n.forEach(i=>{ri(i,t,e)});else if(lf(n)){for(const i in n)ri(n[i],t,e);for(const i of Object.getOwnPropertySymbols(n))Object.prototype.propertyIsEnumerable.call(n,i)&&ri(n[i],t,e)}return n}/**
* @vue/runtime-core v3.5.44
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/function wr(n,t,e,i){try{return i?n(...i):n()}catch(s){Ko(s,t,e)}}function bn(n,t,e,i){if(Ht(n)){const s=wr(n,t,e,i);return s&&of(s)&&s.catch(r=>{Ko(r,t,e)}),s}if(Dt(n)){const s=[];for(let r=0;r<n.length;r++)s.push(bn(n[r],t,e,i));return s}}function Ko(n,t,e,i=!0){const s=t?t.vnode:null,{errorHandler:r,throwUnhandledErrorInProduction:o}=t&&t.appContext.config||ce;if(t){let a=t.parent;const l=t.proxy,u=`https://vuejs.org/error-reference/#runtime-${e}`;for(;a;){const c=a.ec;if(c){for(let h=0;h<c.length;h++)if(c[h](n,l,u)===!1)return}a=a.parent}if(r){kn(),wr(r,null,10,[n,l,u]),Hn();return}}tm(n,e,s,i,o)}function tm(n,t,e,i=!0,s=!1){if(s)throw n;console.error(n)}const Oe=[];let gn=-1;const Cn=[];let yi=null,bs=0;const Pf=Promise.resolve();let Po=null;function Df(n){const t=Po||Pf;return n?t.then(this?n.bind(this):n):t}function em(n){let t=gn+1,e=Oe.length;for(;t<e;){const i=t+e>>>1,s=Oe[i],r=vr(s);r<n||r===n&&s.flags&2?t=i+1:e=i}return t}function Ec(n){if(!(n.flags&1)){const t=vr(n),e=Oe[Oe.length-1];!e||!(n.flags&2)&&t>=vr(e)?Oe.push(n):Oe.splice(em(t),0,n),n.flags|=1,Lf()}}function Lf(){Po||(Po=Pf.then(Nf))}function nm(n){if(!Dt(n))yi&&n.id===-1?yi.splice(bs+1,0,n):n.flags&1||(Cn.push(n),n.flags|=1);else for(let t=0;t<n.length;t++)Cn.push(n[t]);Lf()}function If(n,t,e,i=gn+1){for(;i<Oe.length;i++){const s=Oe[i];if(s&&s.flags&2){if(n&&s.id!==n.uid||t!==void 0&&!(s.id>=t))continue;Oe.splice(i,1),i=n?i-1:gn,s.flags&4&&(s.flags&=-2),s(),s.flags&4||(s.flags&=-2)}}}function Uf(n,t,e=0){if(Cn.length){let i=Cn,s=0;if(t){i=[];for(let o=0;o<Cn.length;o++){const a=Cn[o];(a.i!==void 0?!a.i||a.i.uid<e:t.has(a))?Cn[s++]=a:i.push(a)}}const r=[...new Set(i)].sort((o,a)=>vr(o)-vr(a));if(Cn.length=s,yi){for(let o=0;o<r.length;o++)yi.push(r[o]);return}for(yi=r,bs=0;bs<yi.length;bs++){const o=yi[bs];o.flags&4&&(o.flags&=-2),o.flags&8||o(),o.flags&=-2}yi=null,bs=0}}let pa=!1;function im(n,t){if(pa){n();return}const e=t===void 0?void 0:new Set(Cn);n(),pa=!0;try{If(void 0,t),Uf(void 0,e,t)}finally{pa=!1}}const vr=n=>n.id==null?n.flags&2?-1:1/0:n.id;function Nf(n){try{for(gn=0;gn<Oe.length;gn++){const t=Oe[gn];t&&!(t.flags&8)&&(t.flags&4&&(t.flags&=-2),wr(t,t.i,t.i?15:14),t.flags&4||(t.flags&=-2))}}finally{for(;gn<Oe.length;gn++){const t=Oe[gn];t&&(t.flags&=-2)}gn=-1,Oe.length=0,Uf(),Po=null,(Oe.length||Cn.length)&&Nf()}}let ln=null,Of=null;function Do(n){const t=ln;return ln=n,Of=n&&n.type.__scopeId||null,t}function sm(n,t=ln,e){if(!t||n._n)return n;const i=(...s)=>{i._d&&No(-1);const r=Do(t),o=Qi.length;let a;try{a=n(...s)}finally{for(let l=Qi.length;l>o;l--)ad();Do(r),i._d&&No(1)}return a};return i._n=!0,i._c=!0,i._d=!0,i}function Ui(n,t){if(ln===null)return n;const e=ta(ln),i=n.dirs||(n.dirs=[]);for(let s=0;s<t.length;s++){let[r,o,a,l=ce]=t[s];r&&(Ht(r)&&(r={mounted:r,updated:r}),r.deep&&ri(o),i.push({dir:r,instance:e,value:o,oldValue:void 0,arg:a,modifiers:l}))}return n}function Ni(n,t,e,i){const s=n.dirs,r=t&&t.dirs;for(let o=0;o<s.length;o++){const a=s[o];r&&(a.oldValue=r[o].value);let l=a.dir[i];l&&(kn(),bn(l,e,8,[n.el,a,n,t]),Hn())}}function rm(n,t){if(Be){let e=Be.provides;const i=Be.parent&&Be.parent.provides;i===e&&(e=Be.provides=Object.create(i)),e[n]=t}}function po(n,t,e=!1){const i=n_();if(i||Rs){let s=Rs?Rs._context.provides:i?i.parent==null||i.ce?i.vnode.appContext&&i.vnode.appContext.provides:i.parent.provides:void 0;if(s&&n in s)return s[n];if(arguments.length>1)return e&&Ht(t)?t.call(i&&i.proxy):t}}const om=Symbol.for("v-scx"),am=()=>po(om);function bi(n,t,e){return Ff(n,t,e)}function Ff(n,t,e=ce){const{immediate:i,deep:s,flush:r,once:o}=e,a=we({},e),l=t&&i||!t&&r!=="post";let u;if(Sr){if(r==="sync"){const p=am();u=p.__watcherHandles||(p.__watcherHandles=[])}else if(!l){const p=()=>{};return p.stop=Fn,p.resume=Fn,p.pause=Fn,p}}const c=Be;a.call=(p,g,v)=>bn(p,c,g,v);let h=!1;r==="post"?a.scheduler=p=>{p.i=c,Ge(p,c&&c.suspense)}:r!=="sync"&&(h=!0,a.scheduler=(p,g)=>{g?p():Ec(p)}),a.augmentJob=p=>{t&&(p.flags|=4),h&&(p.flags|=2,c&&(p.id=c.uid,p.i=c))};const d=Qp(n,t,a);return Sr&&(u?u.push(d):l&&d()),d}function lm(n,t,e){const i=this.proxy,s=ve(n)?n.includes(".")?Bf(i,n):()=>i[n]:n.bind(i,i);let r;Ht(t)?r=t:(r=t.handler,e=t);const o=Rr(this),a=Ff(s,r.bind(i),e);return o(),a}function Bf(n,t){const e=t.split(".");return()=>{let i=n;for(let s=0;s<e.length&&i;s++)i=i[e[s]];return i}}const cm=Symbol("_vte"),$o=n=>n.__isTeleport,ma=Symbol("_leaveCb");function um(n){let t=n[0];if(n.length>1){for(const e of n)if(e.type!==Tn){t=e;break}}return t}function zf(n){if(!Tc(n))return $o(n.type)&&n.children?um(n.children):n;if(n.component)return n.component.subTree;const{shapeFlag:t,children:e}=n;if(e){if(t&16)return e[0];if(t&32&&Ht(e.default))return e.default()}}function Lo(n,t){if(n.shapeFlag&6&&n.component){n.transition=t;const e=n.component.subTree;Lo($o(e.type)&&zf(e)||e,t)}else if(n.shapeFlag&128)n.ssContent.transition=t.clone(n.ssContent),n.ssFallback.transition=t.clone(n.ssFallback);else if(n.transition=t,n.type===We&&Dt(n.children)){const e=jf(n.children,!1);e&&Lo(e,t)}}function cl(n){if(n.component)return cl(n.component.subTree);if(n.type===We){const t=Dt(n.children)&&jf(n.children,!1);return t?cl(t):void 0}if(n.type!==Tn)return n}function bc(n,t){return Ht(n)?we({name:n.name},t,{setup:n}):n}function kf(n){n.ids=[n.ids[0]+n.ids[2]+++"-",0,0]}function hu(n,t){let e;return!!((e=Object.getOwnPropertyDescriptor(n,t))&&!e.configurable)}const Io=new WeakMap;function hr(n,t,e,i,s=!1){if(Dt(n)){n.forEach((v,m)=>hr(v,t&&(Dt(t)?t[m]:t),e,i,s));return}if(fr(i)&&!s){i.shapeFlag&512&&i.type.__asyncResolved&&i.component.subTree.component&&hr(n,t,e,i.component.subTree);return}const r=i.shapeFlag&4?ta(i.component):i.el,o=s?null:r,{i:a,r:l}=n,u=t&&t.r,c=a.refs===ce?a.refs={}:a.refs,h=a.setupState,d=se(h),p=h===ce?rf:v=>hu(c,v)?!1:te(d,v),g=(v,m)=>!(m&&hu(c,m));if(u!=null&&u!==l){if(fu(t),ve(u))c[u]=null,p(u)&&(h[u]=null);else if(Le(u)){const v=t;g(u,v.k)&&(u.value=null),v.k&&(c[v.k]=null)}}if(Ht(l))wr(l,a,12,[o,c]);else{const v=ve(l),m=Le(l);if(v||m){const f=()=>{if(n.f){const w=v?p(l)?h[l]:c[l]:g()||!n.k?l.value:c[n.k];if(s)Dt(w)&&fc(w,r);else if(Dt(w))w.includes(r)||w.push(r);else if(v)c[l]=[r],p(l)&&(h[l]=c[l]);else{const b=[r];g(l,n.k)&&(l.value=b),n.k&&(c[n.k]=b)}}else v?(c[l]=o,p(l)&&(h[l]=o)):m&&(g(l,n.k)&&(l.value=o),n.k&&(c[n.k]=o))};if(o){const w=()=>{f(),Io.delete(n)};w.id=-1,Io.set(n,w),Ge(w,e)}else fu(n),f()}}}function fu(n){const t=Io.get(n);t&&(t.flags|=8,Io.delete(n))}qo().requestIdleCallback;qo().cancelIdleCallback;const fr=n=>!!n.type.__asyncLoader,Tc=n=>n.type.__isKeepAlive;function hm(n,t){Hf(n,"a",t)}function fm(n,t){Hf(n,"da",t)}function Hf(n,t,e=Be){const i=n.__wdc||(n.__wdc=()=>{let s=e;for(;s;){if(s.isDeactivated)return;s=s.parent}return n()});if(Zo(t,i,e),e){let s=e.parent;for(;s&&s.parent;)Tc(s.parent.vnode)&&dm(i,t,e,s),s=s.parent}}function dm(n,t,e,i){const s=Zo(t,n,i,!0);Gf(()=>{fc(i[t],s)},e)}function Zo(n,t,e=Be,i=!1){if(e){const s=e[n]||(e[n]=[]),r=t.__weh||(t.__weh=(...o)=>{kn();const a=Rr(e),l=bn(t,e,n,o);return a(),Hn(),l});return i?s.unshift(r):s.push(r),r}}const hi=n=>(t,e=Be)=>{(!Sr||n==="sp")&&Zo(n,(...i)=>t(...i),e)},pm=hi("bm"),Ac=hi("m"),mm=hi("bu"),_m=hi("u"),Vf=hi("bum"),Gf=hi("um"),gm=hi("sp"),vm=hi("rtg"),xm=hi("rtc");function ym(n,t=Be){Zo("ec",n,t)}const Mm=Symbol.for("v-ndc");function Sm(n,t,e,i){let s;const r=e,o=Dt(n);if(o||ve(n)){const a=o&&Ai(n);let l=!1,u=!1;a&&(l=!cn(n),u=Vn(n),n=jo(n)),s=new Array(n.length);for(let c=0,h=n.length;c<h;c++)s[c]=t(l?u?Ci(un(n[c])):un(n[c]):n[c],c,void 0,r)}else if(typeof n=="number")if(!Number.isInteger(n)||n<0)s=[];else{s=new Array(n);for(let a=0;a<n;a++)s[a]=t(a+1,a,void 0,r)}else if(oe(n))if(n[Symbol.iterator])s=Array.from(n,(a,l)=>t(a,l,void 0,r));else{const a=Object.keys(n);s=new Array(a.length);for(let l=0,u=a.length;l<u;l++){const c=a[l];s[l]=t(n[c],c,l,r)}}else s=[];return s}const ul=n=>n?hd(n)?ta(n):ul(n.parent):null,dr=we(Object.create(null),{$:n=>n,$el:n=>n.vnode.el,$data:n=>n.data,$props:n=>n.props,$attrs:n=>n.attrs,$slots:n=>n.slots,$refs:n=>n.refs,$parent:n=>ul(n.parent),$root:n=>ul(n.root),$host:n=>n.ce,$emit:n=>n.emit,$options:n=>Xf(n),$forceUpdate:n=>n.f||(n.f=()=>{Ec(n.update)}),$nextTick:n=>n.n||(n.n=Df.bind(n.proxy)),$watch:n=>lm.bind(n)}),_a=(n,t)=>n!==ce&&!n.__isScriptSetup&&te(n,t),Em={get({_:n},t){if(t==="__v_skip")return!0;const{ctx:e,setupState:i,data:s,props:r,accessCache:o,type:a,appContext:l}=n;if(t[0]!=="$"){const d=o[t];if(d!==void 0)switch(d){case 1:return i[t];case 2:return s[t];case 4:return e[t];case 3:return r[t]}else{if(_a(i,t))return o[t]=1,i[t];if(s!==ce&&te(s,t))return o[t]=2,s[t];if(te(r,t))return o[t]=3,r[t];if(e!==ce&&te(e,t))return o[t]=4,e[t];hl&&(o[t]=0)}}const u=dr[t];let c,h;if(u)return t==="$attrs"&&De(n.attrs,"get",""),u(n);if((c=a.__cssModules)&&(c=c[t]))return c;if(e!==ce&&te(e,t))return o[t]=4,e[t];if(h=l.config.globalProperties,te(h,t))return h[t]},set({_:n},t,e){const{data:i,setupState:s,ctx:r}=n;return _a(s,t)?(s[t]=e,!0):i!==ce&&te(i,t)?(i[t]=e,!0):te(n.props,t)||t[0]==="$"&&t.slice(1)in n?!1:(r[t]=e,!0)},has({_:{data:n,setupState:t,accessCache:e,ctx:i,appContext:s,props:r,type:o}},a){let l;return!!(e[a]||n!==ce&&a[0]!=="$"&&te(n,a)||_a(t,a)||te(r,a)||te(i,a)||te(dr,a)||te(s.config.globalProperties,a)||(l=o.__cssModules)&&l[a])},defineProperty(n,t,e){return e.get!=null?n._.accessCache[t]=0:te(e,"value")&&this.set(n,t,e.value,null),Reflect.defineProperty(n,t,e)}};function du(n){return Dt(n)?n.reduce((t,e)=>(t[e]=null,t),{}):n}let hl=!0;function bm(n){const t=Xf(n),e=n.proxy,i=n.ctx;hl=!1,t.beforeCreate&&pu(t.beforeCreate,n,"bc");const{data:s,computed:r,methods:o,watch:a,provide:l,inject:u,created:c,beforeMount:h,mounted:d,beforeUpdate:p,updated:g,activated:v,deactivated:m,beforeDestroy:f,beforeUnmount:w,destroyed:b,unmounted:x,render:B,renderTracked:P,renderTriggered:D,errorCaptured:N,serverPrefetch:E,expose:M,inheritAttrs:L,components:J,directives:C,filters:k}=t;if(u&&Tm(u,i,null),o)for(const q in o){const z=o[q];Ht(z)&&(i[q]=z.bind(e))}if(s){const q=s.call(e,e);oe(q)&&(n.data=Ar(q))}if(hl=!0,r)for(const q in r){const z=r[q],at=Ht(z)?z.bind(e,e):Ht(z.get)?z.get.bind(e,e):Fn,dt=!Ht(z)&&Ht(z.set)?z.set.bind(e):Fn,bt=ts({get:at,set:dt});Object.defineProperty(i,q,{enumerable:!0,configurable:!0,get:()=>bt.value,set:Ut=>bt.value=Ut})}if(a)for(const q in a)Wf(a[q],i,e,q);if(l){const q=Ht(l)?l.call(e):l;Reflect.ownKeys(q).forEach(z=>{rm(z,q[z])})}c&&pu(c,n,"c");function H(q,z){Dt(z)?z.forEach(at=>q(at.bind(e))):z&&q(z.bind(e))}if(H(pm,h),H(Ac,d),H(mm,p),H(_m,g),H(hm,v),H(fm,m),H(ym,N),H(xm,P),H(vm,D),H(Vf,w),H(Gf,x),H(gm,E),Dt(M))if(M.length){const q=n.exposed||(n.exposed={});M.forEach(z=>{Object.defineProperty(q,z,{get:()=>e[z],set:at=>e[z]=at,enumerable:!0})})}else n.exposed||(n.exposed={});B&&n.render===Fn&&(n.render=B),L!=null&&(n.inheritAttrs=L),J&&(n.components=J),C&&(n.directives=C),E&&kf(n)}function Tm(n,t,e=Fn){Dt(n)&&(n=fl(n));for(const i in n){const s=n[i];let r;oe(s)?"default"in s?r=po(s.from||i,s.default,!0):r=po(s.from||i):r=po(s),Le(r)?Object.defineProperty(t,i,{enumerable:!0,configurable:!0,get:()=>r.value,set:o=>r.value=o}):t[i]=r}}function pu(n,t,e){bn(Dt(n)?n.map(i=>i.bind(t.proxy)):n.bind(t.proxy),t,e)}function Wf(n,t,e,i){let s=i.includes(".")?Bf(e,i):()=>e[i];if(ve(n)){const r=t[n];Ht(r)&&bi(s,r)}else if(Ht(n))bi(s,n.bind(e));else if(oe(n))if(Dt(n))n.forEach(r=>Wf(r,t,e,i));else{const r=Ht(n.handler)?n.handler.bind(e):t[n.handler];Ht(r)&&bi(s,r,n)}}function Xf(n){const t=n.type,{mixins:e,extends:i}=t,{mixins:s,optionsCache:r,config:{optionMergeStrategies:o}}=n.appContext,a=r.get(t);let l;return a?l=a:!s.length&&!e&&!i?l=t:(l={},s.length&&s.forEach(u=>Uo(l,u,o,!0)),Uo(l,t,o)),oe(t)&&r.set(t,l),l}function Uo(n,t,e,i=!1){const{mixins:s,extends:r}=t;r&&Uo(n,r,e,!0),s&&s.forEach(o=>Uo(n,o,e,!0));for(const o in t)if(!(i&&o==="expose")){const a=Am[o]||e&&e[o];n[o]=a?a(n[o],t[o]):t[o]}return n}const Am={data:mu,props:_u,emits:_u,methods:nr,computed:nr,beforeCreate:Ue,created:Ue,beforeMount:Ue,mounted:Ue,beforeUpdate:Ue,updated:Ue,beforeDestroy:Ue,beforeUnmount:Ue,destroyed:Ue,unmounted:Ue,activated:Ue,deactivated:Ue,errorCaptured:Ue,serverPrefetch:Ue,components:nr,directives:nr,watch:Rm,provide:mu,inject:wm};function mu(n,t){return t?n?function(){return we(Ht(n)?n.call(this,this):n,Ht(t)?t.call(this,this):t)}:t:n}function wm(n,t){return nr(fl(n),fl(t))}function fl(n){if(Dt(n)){const t={};for(let e=0;e<n.length;e++)t[n[e]]=n[e];return t}return n}function Ue(n,t){return n?[...new Set([].concat(n,t))]:t}function nr(n,t){return n?we(Object.create(null),n,t):t}function _u(n,t){return n?Dt(n)&&Dt(t)?[...new Set([...n,...t])]:we(Object.create(null),du(n),du(t??{})):t}function Rm(n,t){if(!n)return t;if(!t)return n;const e=we(Object.create(null),n);for(const i in t)e[i]=Ue(n[i],t[i]);return e}function qf(){return{app:null,config:{isNativeTag:rf,performance:!1,globalProperties:{},optionMergeStrategies:{},errorHandler:void 0,warnHandler:void 0,compilerOptions:{}},mixins:[],components:{},directives:{},provides:Object.create(null),optionsCache:new WeakMap,propsCache:new WeakMap,emitsCache:new WeakMap}}let Cm=0;function Pm(n,t){return function(i,s=null){Ht(i)||(i=we({},i)),s!=null&&!oe(s)&&(s=null);const r=qf(),o=new WeakSet,a=[];let l=!1;const u=r.app={_uid:Cm++,_component:i,_props:s,_container:null,_context:r,_instance:null,version:l_,get config(){return r.config},set config(c){},use(c,...h){return o.has(c)||(c&&Ht(c.install)?(o.add(c),c.install(u,...h)):Ht(c)&&(o.add(c),c(u,...h))),u},mixin(c){return r.mixins.includes(c)||r.mixins.push(c),u},component(c,h){return h?(r.components[c]=h,u):r.components[c]},directive(c,h){return h?(r.directives[c]=h,u):r.directives[c]},mount(c,h,d){if(!l){const p=u._ceVNode||Xe(i,s);return p.appContext=r,d===!0?d="svg":d===!1&&(d=void 0),n(p,c,d),l=!0,u._container=c,c.__vue_app__=u,ta(p.component)}},onUnmount(c){a.push(c)},unmount(){l&&(bn(a,u._instance,16),n(null,u._container),delete u._container.__vue_app__)},provide(c,h){return r.provides[c]=h,u},runWithContext(c){const h=Rs;Rs=u;try{return c()}finally{Rs=h}}};return u}}let Rs=null;const Dm=(n,t)=>t==="modelValue"||t==="model-value"?n.modelModifiers:n[`${t}Modifiers`]||n[`${Mn(t)}Modifiers`]||n[`${ss(t)}Modifiers`];function Lm(n,t,...e){if(n.isUnmounted)return;const i=n.vnode.props||ce;let s=e;const r=t.startsWith("update:"),o=r&&Dm(i,t.slice(7));o&&(o.trim&&(s=e.map(c=>ve(c)?c.trim():c)),o.number&&(s=s.map(Xo)));let a,l=i[a=ca(t)]||i[a=ca(Mn(t))];!l&&r&&(l=i[a=ca(ss(t))]),l&&bn(l,n,6,s);const u=i[a+"Once"];if(u){if(!n.emitted)n.emitted={};else if(n.emitted[a])return;n.emitted[a]=!0,bn(u,n,6,s)}}const Im=new WeakMap;function Yf(n,t,e=!1){const i=e?Im:t.emitsCache,s=i.get(n);if(s!==void 0)return s;const r=n.emits;let o={},a=!1;if(!Ht(n)){const l=u=>{const c=Yf(u,t,!0);c&&(a=!0,we(o,c))};!e&&t.mixins.length&&t.mixins.forEach(l),n.extends&&l(n.extends),n.mixins&&n.mixins.forEach(l)}return!r&&!a?(oe(n)&&i.set(n,null),null):(Dt(r)?r.forEach(l=>o[l]=null):we(o,r),oe(n)&&i.set(n,o),o)}function Jo(n,t){return!n||!Vo(t)?!1:(t=t.slice(2),t=t==="Once"?t:t.replace(/Once$/,""),te(n,t[0].toLowerCase()+t.slice(1))||te(n,ss(t))||te(n,t))}function gu(n){const{type:t,vnode:e,proxy:i,withProxy:s,propsOptions:[r],slots:o,attrs:a,emit:l,render:u,renderCache:c,props:h,data:d,setupState:p,ctx:g,inheritAttrs:v}=n,m=Do(n);let f,w;try{if(e.shapeFlag&4){const x=s||i,B=x;f=Pn(u.call(B,x,c,h,p,d,g)),w=a}else{const x=t;f=Pn(x.length>1?x(h,{attrs:a,slots:o,emit:l}):x(h,null)),w=t.props?a:Um(a)}}catch(x){Qi.length=0,Ko(x,n,1),f=Xe(Tn)}let b=f;if(w&&v!==!1){const x=Object.keys(w),{shapeFlag:B}=b;x.length&&B&7&&(r&&x.some(Go)&&(w=Nm(w,r)),b=Is(b,w,!1,!0))}if(e.dirs&&(b=Is(b,null,!1,!0),b.dirs=b.dirs?b.dirs.concat(e.dirs):e.dirs),e.transition){const x=$o(b.type)&&zf(b)||b;Lo(x,e.transition)}return f=b,Do(m),f}function jf(n,t=!0){let e;for(let i=0;i<n.length;i++){const s=n[i];if(yr(s)){if(s.type!==Tn||s.children==="v-if"){if(e)return;e=s}}else return}return e}const Um=n=>{let t;for(const e in n)(e==="class"||e==="style"||Vo(e))&&((t||(t={}))[e]=n[e]);return t},Nm=(n,t)=>{const e={};for(const i in n)(!Go(i)||!(i.slice(9)in t))&&(e[i]=n[i]);return e};function Om(n,t,e){const{props:i,children:s,component:r}=n,{props:o,children:a,patchFlag:l}=t,u=r.emitsOptions;if(t.dirs||t.transition)return!0;if(e&&l>=0){if(l&1024)return!0;if(l&16)return i?vu(i,o,u):!!o;if(l&8){const c=t.dynamicProps;for(let h=0;h<c.length;h++){const d=c[h];if(Kf(o,i,d)&&!Jo(u,d))return!0}}}else return(s||a)&&(!a||!a.$stable)?!0:i===o?!1:i?o?vu(i,o,u):!0:!!o;return!1}function vu(n,t,e){const i=Object.keys(t);if(i.length!==Object.keys(n).length)return!0;for(let s=0;s<i.length;s++){const r=i[s];if(!te(n,r)||Kf(t,n,r)&&!Jo(e,r))return!0}return!1}function Kf(n,t,e){const i=n[e],s=t[e];return e==="style"&&oe(i)&&oe(s)?!ci(i,s):i!==s}function Fm({vnode:n,parent:t,suspense:e},i){for(;t;){const s=t.subTree;if(s.suspense&&s.suspense.activeBranch===n&&(s.suspense.vnode.el=s.el=i,n=s),s===n)(n=t.vnode).el=i,t=t.parent;else break}e&&e.activeBranch===n&&(e.vnode.el=i)}const $f={},Zf=()=>Object.create($f),Jf=n=>Object.getPrototypeOf(n)===$f;function Bm(n,t,e,i=!1){const s={},r=Zf();n.propsDefaults=Object.create(null),Qf(n,t,s,r);for(const o in n.propsOptions[0])o in s||(s[o]=void 0);e?n.props=i?s:Xp(s):n.type.props?n.props=s:n.props=r,n.attrs=r}function zm(n,t,e,i){const{props:s,attrs:r,vnode:{patchFlag:o}}=n,a=se(s),[l]=n.propsOptions;let u=!1;if((i||o>0)&&!(o&16)){if(o&8){const c=n.vnode.dynamicProps;for(let h=0;h<c.length;h++){let d=c[h];if(Jo(n.emitsOptions,d))continue;const p=t[d];if(l)if(te(r,d))p!==r[d]&&(r[d]=p,u=!0);else{const g=Mn(d);s[g]=dl(l,a,g,p,n,!1)}else p!==r[d]&&(r[d]=p,u=!0)}}}else{Qf(n,t,s,r)&&(u=!0);let c;for(const h in a)(!t||!te(t,h)&&((c=ss(h))===h||!te(t,c)))&&(l?e&&(e[h]!==void 0||e[c]!==void 0)&&(s[h]=dl(l,a,h,void 0,n,!0)):delete s[h]);if(r!==a)for(const h in r)(!t||!te(t,h))&&(delete r[h],u=!0)}u&&si(n.attrs,"set","")}function Qf(n,t,e,i){const[s,r]=n.propsOptions;let o=!1,a;if(t)for(let l in t){if(lr(l))continue;const u=t[l];let c;s&&te(s,c=Mn(l))?!r||!r.includes(c)?e[c]=u:(a||(a={}))[c]=u:Jo(n.emitsOptions,l)||(!(l in i)||u!==i[l])&&(i[l]=u,o=!0)}if(r){const l=se(e),u=a||ce;for(let c=0;c<r.length;c++){const h=r[c];e[h]=dl(s,l,h,u[h],n,!te(u,h))}}return o}function dl(n,t,e,i,s,r){const o=n[e];if(o!=null){const a=te(o,"default");if(a&&i===void 0){const l=o.default;if(o.type!==Function&&!o.skipFactory&&Ht(l)){const{propsDefaults:u}=s;if(e in u)i=u[e];else{const c=Rr(s);i=u[e]=l.call(null,t),c()}}else i=l;s.ce&&s.ce._setProp(e,i)}o[0]&&(r&&!a?i=!1:o[1]&&(i===""||i===ss(e))&&(i=!0))}return i}const km=new WeakMap;function td(n,t,e=!1){const i=e?km:t.propsCache,s=i.get(n);if(s)return s;const r=n.props,o={},a=[];let l=!1;if(!Ht(n)){const c=h=>{l=!0;const[d,p]=td(h,t,!0);we(o,d),p&&a.push(...p)};!e&&t.mixins.length&&t.mixins.forEach(c),n.extends&&c(n.extends),n.mixins&&n.mixins.forEach(c)}if(!r&&!l)return oe(n)&&i.set(n,Ki),Ki;if(Dt(r))for(let c=0;c<r.length;c++){const h=Mn(r[c]);xu(h)&&(o[h]=ce)}else if(r)for(const c in r){const h=Mn(c);if(xu(h)){const d=r[c],p=o[h]=Dt(d)||Ht(d)?{type:d}:we({},d),g=p.type;let v=!1,m=!0;if(Dt(g))for(let f=0;f<g.length;++f){const w=g[f],b=Ht(w)&&w.name;if(b==="Boolean"){v=!0;break}else b==="String"&&(m=!1)}else v=Ht(g)&&g.name==="Boolean";p[0]=v,p[1]=m,(v||te(p,"default"))&&a.push(h)}}const u=[o,a];return oe(n)&&i.set(n,u),u}function xu(n){return n[0]!=="$"&&!lr(n)}const wc=n=>n==="_"||n==="_ctx"||n==="$stable",Rc=n=>Dt(n)?n.map(Pn):[Pn(n)],Hm=(n,t,e)=>{if(t._n)return t;const i=sm((...s)=>Rc(t(...s)),e);return i._c=!1,i},ed=(n,t,e)=>{const i=n._ctx;for(const s in n){if(wc(s))continue;const r=n[s];if(Ht(r))t[s]=Hm(s,r,i);else if(r!=null){const o=Rc(r);t[s]=()=>o}}},nd=(n,t)=>{const e=Rc(t);n.slots.default=()=>e},id=(n,t,e)=>{for(const i in t)(e||!wc(i))&&(n[i]=t[i])},Vm=(n,t,e)=>{const i=n.slots=Zf();if(n.vnode.shapeFlag&32){const s=t._;s?(id(i,t,e),e&&uf(i,"_",s,!0)):ed(t,i)}else t&&nd(n,t)},Gm=(n,t,e)=>{const{vnode:i,slots:s}=n;let r=!0,o=ce;if(i.shapeFlag&32){const a=t._;a?e&&a===1?r=!1:id(s,t,e):(r=!t.$stable,ed(t,s)),o=t}else t&&(nd(n,t),o={default:1});if(r)for(const a in s)!wc(a)&&o[a]==null&&delete s[a]},Ge=jm;function Wm(n){return Xm(n)}function Xm(n,t){const e=qo();e.__VUE__=!0;const{insert:i,remove:s,patchProp:r,createElement:o,createText:a,createComment:l,setText:u,setElementText:c,parentNode:h,nextSibling:d,setScopeId:p=Fn,insertStaticContent:g}=n,v=(A,R,X,T=null,nt=null,Z=null,st=void 0,tt=null,rt=!!R.dynamicChildren)=>{if(A===R)return;A&&!Ys(A,R)&&(T=mt(A),Ut(A,nt,Z,!0),A=null),R.patchFlag===-2&&(rt=!1,R.dynamicChildren=null),R.dynamicChildren&&A&&A.dynamicChildren&&A.dynamicChildren.hasOnce&&(R.dynamicChildren===Ki&&(R.dynamicChildren=[]),R.dynamicChildren.hasOnce=!0);const{type:V,ref:S,shapeFlag:_}=R;switch(V){case Qo:m(A,R,X,T);break;case Tn:f(A,R,X,T);break;case va:A==null&&w(R,X,T,st);break;case We:J(A,R,X,T,nt,Z,st,tt,rt);break;default:_&1?B(A,R,X,T,nt,Z,st,tt,rt):_&6?C(A,R,X,T,nt,Z,st,tt,rt):(_&64||_&128)&&V.process(A,R,X,T,nt,Z,st,tt,rt,Nt)}S!=null&&nt?hr(S,A&&A.ref,Z,R||A,!R):S==null&&A&&A.ref!=null&&hr(A.ref,null,Z,A,!0)},m=(A,R,X,T)=>{if(A==null)i(R.el=a(R.children),X,T);else{const nt=R.el=A.el;R.children!==A.children&&u(nt,R.children)}},f=(A,R,X,T)=>{A==null?i(R.el=l(R.children||""),X,T):R.el=A.el},w=(A,R,X,T)=>{[A.el,A.anchor]=g(A.children,R,X,T,A.el,A.anchor)},b=({el:A,anchor:R},X,T)=>{let nt;for(;A&&A!==R;)nt=d(A),i(A,X,T),A=nt;i(R,X,T)},x=({el:A,anchor:R})=>{let X;for(;A&&A!==R;)X=d(A),s(A),A=X;s(R)},B=(A,R,X,T,nt,Z,st,tt,rt)=>{if(R.type==="svg"?st="svg":R.type==="math"&&(st="mathml"),A==null)P(R,X,T,nt,Z,st,tt,rt);else{const V=A.el&&A.el._isVueCE?A.el:null;try{V&&V._beginPatch(),E(A,R,nt,Z,st,tt,rt)}finally{V&&V._endPatch()}}},P=(A,R,X,T,nt,Z,st,tt)=>{let rt,V;const{props:S,shapeFlag:_,transition:I,dirs:W}=A;if(rt=A.el=o(A.type,Z,S&&S.is,S),_&8?c(rt,A.children):_&16&&N(A.children,rt,null,T,nt,ga(A,Z),st,tt),W&&Ni(A,null,T,"created"),D(rt,A,A.scopeId,st,T),S){for(const $ in S)$!=="value"&&!lr($)&&r(rt,$,null,S[$],Z,T);"value"in S&&r(rt,"value",null,S.value,Z),(V=S.onVnodeBeforeMount)&&wn(V,T,A)}W&&Ni(A,null,T,"beforeMount");const Q=qm(nt,I);Q&&I.beforeEnter(rt),i(rt,R,X),((V=S&&S.onVnodeMounted)||Q||W)&&Ge(()=>{try{V&&wn(V,T,A),Q&&I.enter(rt),W&&Ni(A,null,T,"mounted")}finally{}},nt)},D=(A,R,X,T,nt)=>{if(X&&p(A,X),T)for(let Z=0;Z<T.length;Z++)p(A,T[Z]);if(nt){let Z=nt.subTree;if(R===Z||od(Z.type)&&(Z.ssContent===R||Z.ssFallback===R)){const st=nt.vnode;D(A,st,st.scopeId,st.slotScopeIds,nt.parent)}}},N=(A,R,X,T,nt,Z,st,tt,rt=0)=>{for(let V=rt;V<A.length;V++){const S=A[V]=tt?ii(A[V]):Pn(A[V]);v(null,S,R,X,T,nt,Z,st,tt)}},E=(A,R,X,T,nt,Z,st)=>{const tt=R.el=A.el;let{patchFlag:rt,dynamicChildren:V,dirs:S}=R;rt|=A.patchFlag&16;const _=A.props||ce,I=R.props||ce;let W;if(X&&Oi(X,!1),(W=I.onVnodeBeforeUpdate)&&wn(W,X,R,A),S&&Ni(R,A,X,"beforeUpdate"),X&&Oi(X,!0),V&&(!A.dynamicChildren||A.dynamicChildren.length!==V.length)&&(rt=0,st=!1,V=null),(_.innerHTML&&I.innerHTML==null||_.textContent&&I.textContent==null)&&c(tt,""),V?M(A.dynamicChildren,V,tt,X,T,ga(R,nt),Z):st||z(A,R,tt,null,X,T,ga(R,nt),Z,!1),rt>0){if(rt&16)L(tt,_,I,X,nt);else if(rt&2&&_.class!==I.class&&r(tt,"class",null,I.class,nt),rt&4&&r(tt,"style",_.style,I.style,nt),rt&8){const Q=R.dynamicProps;for(let $=0;$<Q.length;$++){const ht=Q[$],ct=_[ht],pt=I[ht];(pt!==ct||ht==="value")&&r(tt,ht,ct,pt,nt,X)}}rt&1&&A.children!==R.children&&c(tt,R.children)}else!st&&V==null&&L(tt,_,I,X,nt);((W=I.onVnodeUpdated)||S)&&Ge(()=>{W&&wn(W,X,R,A),S&&Ni(R,A,X,"updated")},T)},M=(A,R,X,T,nt,Z,st)=>{for(let tt=0;tt<R.length;tt++){const rt=A[tt],V=R[tt],S=rt.el||pl(rt),_=S&&(rt.type===We||!Ys(rt,V)||rt.shapeFlag&198)?h(S):X;v(rt,V,_,null,T,nt,Z,st,!0)}},L=(A,R,X,T,nt)=>{if(R!==X){if(R!==ce)for(const Z in R)!lr(Z)&&!(Z in X)&&r(A,Z,R[Z],null,nt,T);for(const Z in X){if(lr(Z))continue;const st=X[Z],tt=R[Z];st!==tt&&Z!=="value"&&r(A,Z,tt,st,nt,T)}"value"in X&&r(A,"value",R.value,X.value,nt)}},J=(A,R,X,T,nt,Z,st,tt,rt)=>{const V=R.el=A?A.el:a(""),S=R.anchor=A?A.anchor:a("");let{patchFlag:_,dynamicChildren:I,slotScopeIds:W}=R;W&&(tt=tt?tt.concat(W):W),A==null?(i(V,X,T),i(S,X,T),N(R.children||[],X,S,nt,Z,st,tt,rt)):_>0&&_&64&&I&&A.dynamicChildren&&A.dynamicChildren.length===I.length?(M(A.dynamicChildren,I,X,nt,Z,st,tt),(R.key!=null||nt&&R===nt.subTree)&&sd(A,R,!0)):z(A,R,X,S,nt,Z,st,tt,rt)},C=(A,R,X,T,nt,Z,st,tt,rt)=>{R.slotScopeIds=tt,A==null?R.shapeFlag&512?nt.ctx.activate(R,X,T,st,rt):k(R,X,T,nt,Z,st,rt):Y(A,R,rt)},k=(A,R,X,T,nt,Z,st)=>{const tt=A.component=e_(A,T,nt);if(Tc(A)&&(tt.ctx.renderer=Nt),i_(tt,!1,st),tt.asyncDep){if(nt&&nt.registerDep(tt,H,st,Z),!A.el){const rt=tt.subTree=Xe(Tn);f(null,rt,R,X),A.placeholder=rt.el}}else H(tt,A,R,X,nt,Z,st)},Y=(A,R,X)=>{const T=R.component=A.component;if(Om(A,R,X))if(T.asyncDep&&!T.asyncResolved){R.el=A.el,R.placeholder=A.placeholder,q(T,R,X);return}else T.next=R,T.update();else R.el=A.el,R.placeholder=A.placeholder,T.vnode=R},H=(A,R,X,T,nt,Z,st)=>{const tt=()=>{if(A.isMounted){let{next:_,bu:I,u:W,parent:Q,vnode:$}=A;{const lt=rd(A);if(lt){_&&(_.el=$.el,q(A,_,st)),lt.asyncDep.then(()=>{Ge(()=>{A.isUnmounted||V()},nt)});return}}let ht=_,ct;Oi(A,!1),_?(_.el=$.el,q(A,_,st)):_=$,I&&fo(I),(ct=_.props&&_.props.onVnodeBeforeUpdate)&&wn(ct,Q,_,$),Oi(A,!0);const pt=gu(A),Ft=A.subTree;A.subTree=pt,v(Ft,pt,h(Ft.el),mt(Ft),A,nt,Z),_.el=pt.el,ht===null&&Fm(A,pt.el),W&&Ge(W,nt),(ct=_.props&&_.props.onVnodeUpdated)&&Ge(()=>wn(ct,Q,_,$),nt)}else{let _;const{el:I,props:W}=R,{bm:Q,m:$,parent:ht,root:ct,type:pt}=A,Ft=fr(R);Oi(A,!1),Q&&fo(Q),!Ft&&(_=W&&W.onVnodeBeforeMount)&&wn(_,ht,R),Oi(A,!0);{ct.ce&&ct.ce._hasShadowRoot()&&ct.ce._injectChildStyle(pt,A.parent?A.parent.type:void 0);const lt=A.subTree=gu(A);v(null,lt,X,T,A,nt,Z),R.el=lt.el}if($&&Ge($,nt),!Ft&&(_=W&&W.onVnodeMounted)){const lt=R;Ge(()=>wn(_,ht,lt),nt)}(R.shapeFlag&256||ht&&fr(ht.vnode)&&ht.vnode.shapeFlag&256)&&A.a&&Ge(A.a,nt),A.isMounted=!0,R=X=T=null}};A.scope.on();const rt=A.effect=new pf(tt);A.scope.off();const V=A.update=rt.run.bind(rt),S=A.job=rt.runIfDirty.bind(rt);S.i=A,S.id=A.uid,rt.scheduler=()=>Ec(S),Oi(A,!0),V()},q=(A,R,X)=>{R.component=A;const T=A.vnode.props;A.vnode=R,A.next=null,zm(A,R.props,T,X),Gm(A,R.children,X),kn(),If(A),Hn()},z=(A,R,X,T,nt,Z,st,tt,rt=!1)=>{const V=A&&A.children,S=A?A.shapeFlag:0,_=R.children,{patchFlag:I,shapeFlag:W}=R;if(I>0){if(I&128){dt(V,_,X,T,nt,Z,st,tt,rt);return}else if(I&256){at(V,_,X,T,nt,Z,st,tt,rt);return}}W&8?(S&16&&Tt(V,nt,Z),_!==V&&c(X,_)):S&16?W&16?dt(V,_,X,T,nt,Z,st,tt,rt):Tt(V,nt,Z,!0):(S&8&&c(X,""),W&16&&N(_,X,T,nt,Z,st,tt,rt))},at=(A,R,X,T,nt,Z,st,tt,rt)=>{A=A||Ki,R=R||Ki;const V=A.length,S=R.length,_=Math.min(V,S);let I;for(I=0;I<_;I++){const W=R[I]=rt?ii(R[I]):Pn(R[I]);v(A[I],W,X,null,nt,Z,st,tt,rt)}V>S?Tt(A,nt,Z,!0,!1,_):N(R,X,T,nt,Z,st,tt,rt,_)},dt=(A,R,X,T,nt,Z,st,tt,rt)=>{let V=0;const S=R.length;let _=A.length-1,I=S-1;for(;V<=_&&V<=I;){const W=A[V],Q=R[V]=rt?ii(R[V]):Pn(R[V]);if(Ys(W,Q))v(W,Q,X,null,nt,Z,st,tt,rt);else break;V++}for(;V<=_&&V<=I;){const W=A[_],Q=R[I]=rt?ii(R[I]):Pn(R[I]);if(Ys(W,Q))v(W,Q,X,null,nt,Z,st,tt,rt);else break;_--,I--}if(V>_){if(V<=I){const W=I+1,Q=W<S?R[W].el:T;for(;V<=I;)v(null,R[V]=rt?ii(R[V]):Pn(R[V]),X,Q,nt,Z,st,tt,rt),V++}}else if(V>I)for(;V<=_;)Ut(A[V],nt,Z,!0),V++;else{const W=V,Q=V,$=new Map;for(V=Q;V<=I;V++){const At=R[V]=rt?ii(R[V]):Pn(R[V]);At.key!=null&&$.set(At.key,V)}let ht,ct=0;const pt=I-Q+1;let Ft=!1,lt=0;const St=new Array(pt);for(V=0;V<pt;V++)St[V]=0;for(V=W;V<=_;V++){const At=A[V];if(ct>=pt){Ut(At,nt,Z,!0);continue}let gt;if(At.key!=null)gt=$.get(At.key);else for(ht=Q;ht<=I;ht++)if(St[ht-Q]===0&&Ys(At,R[ht])){gt=ht;break}gt===void 0?Ut(At,nt,Z,!0):(St[gt-Q]=V+1,gt>=lt?lt=gt:Ft=!0,v(At,R[gt],X,null,nt,Z,st,tt,rt),ct++)}const Lt=Ft?Ym(St):Ki;for(ht=Lt.length-1,V=pt-1;V>=0;V--){const At=Q+V,gt=R[At],Kt=R[At+1],zt=At+1<S?Kt.el||pl(Kt):T;St[V]===0?v(null,gt,X,zt,nt,Z,st,tt,rt):Ft&&(ht<0||V!==Lt[ht]?bt(gt,X,zt,2):ht--)}}},bt=(A,R,X,T,nt=null)=>{const{el:Z,type:st,transition:tt,children:rt,shapeFlag:V}=A;if(V&6){bt(A.component.subTree,R,X,T);return}if(V&128){A.suspense.move(R,X,T);return}if(V&64){st.move(A,R,X,Nt);return}if(st===We){i(Z,R,X);for(let _=0;_<rt.length;_++)bt(rt[_],R,X,T);i(A.anchor,R,X);return}if(st===va){b(A,R,X);return}if(T!==2&&V&1&&tt)if(T===0)tt.persisted&&!Z[ma]?i(Z,R,X):(tt.beforeEnter(Z),i(Z,R,X),Ge(()=>tt.enter(Z),nt));else{const{leave:_,delayLeave:I,afterLeave:W}=tt,Q=()=>{A.ctx.isUnmounted?s(Z):i(Z,R,X)},$=()=>{const ht=Z._isLeaving||!!Z[ma];Z._isLeaving&&Z[ma](!0),tt.persisted&&!ht?Q():_(Z,()=>{Q(),W&&W()})};I?I(Z,Q,$):$()}else i(Z,R,X)},Ut=(A,R,X,T=!1,nt=!1)=>{const{type:Z,props:st,ref:tt,children:rt,dynamicChildren:V,shapeFlag:S,patchFlag:_,dirs:I,cacheIndex:W,memo:Q}=A;if((_===-2||V&&V.hasOnce)&&(nt=!1),tt!=null&&(kn(),hr(tt,null,X,A,!0),Hn()),W!=null&&(!A.ctx||A.ctx===R)&&(R.renderCache[W]=void 0),S&256){R.ctx.deactivate(A);return}const $=S&1&&I,ht=!fr(A);let ct;if(ht&&(ct=st&&st.onVnodeBeforeUnmount)&&wn(ct,R,A),S&6)ut(A.component,X,T);else{if(S&128){A.suspense.unmount(X,T);return}$&&Ni(A,null,R,"beforeUnmount"),S&64?A.type.remove(A,R,X,Nt,T):V&&!V.hasOnce&&(Z!==We||_>0&&_&64)?Tt(V,R,X,!1,!0):(Z===We&&_&384||!nt&&S&16)&&Tt(rt,R,X),T&&ee(A)}const pt=Q!=null&&W==null;(ht&&(ct=st&&st.onVnodeUnmounted)||$||pt)&&Ge(()=>{ct&&wn(ct,R,A),$&&Ni(A,null,R,"unmounted"),pt&&(A.el=null)},X)},ee=A=>{const{type:R,el:X,anchor:T,transition:nt}=A,Z=R===We;if(Z&&!nt){it(X,T);return}if(R===va){x(A),nt&&!nt.persisted&&nt.afterLeave&&nt.afterLeave();return}const st=Z?cl(A):A,tt=()=>{Z?h(X)&&it(X,T):s(X),nt&&!nt.persisted&&nt.afterLeave&&nt.afterLeave()};if(st&&st.shapeFlag&1&&nt&&!nt.persisted){const{leave:rt,delayLeave:V}=nt,S=st.el,_=()=>rt(S,tt);V?V(S,tt,_):_()}else tt()},it=(A,R)=>{let X;for(;A!==R;)X=d(A),s(A),A=X;s(R)},ut=(A,R,X)=>{const{bum:T,scope:nt,job:Z,subTree:st,um:tt,m:rt,a:V}=A;yu(rt),yu(V),T&&fo(T),nt.stop(),Z?(Z.flags|=8,Ut(st,A,R,X)):A.vnode.el&&st&&(st.transition=A.vnode.transition,Ut(st,A,R,X)),tt&&Ge(tt,R),Ge(()=>{A.isUnmounted=!0},R)},Tt=(A,R,X,T=!1,nt=!1,Z=0)=>{for(let st=Z;st<A.length;st++)Ut(A[st],R,X,T,nt)},mt=A=>{if(A.shapeFlag&6)return mt(A.component.subTree);if(A.shapeFlag&128)return A.suspense.next();const R=d(A.anchor||A.el),X=R&&R[cm];return X?d(X):R},It=(A,R,X)=>{const T=A&&R._vnode?void 0:A&&A.component?A.component.uid:t_();im(()=>{A==null?R._vnode&&Ut(R._vnode,null,null,!0):v(R._vnode||null,A,R,null,null,null,X),R._vnode=A},T)},Nt={p:v,um:Ut,m:bt,r:ee,mt:k,mc:N,pc:z,pbc:M,n:mt,o:n};return{render:It,hydrate:void 0,createApp:Pm(It)}}function ga({type:n,props:t},e){return e==="svg"&&n==="foreignObject"||e==="mathml"&&n==="annotation-xml"&&t&&t.encoding&&t.encoding.includes("html")?void 0:e}function Oi({effect:n,job:t},e){e?(n.flags|=32,t.flags|=4):(n.flags&=-33,t.flags&=-5)}function qm(n,t){return(!n||n&&!n.pendingBranch)&&t&&!t.persisted}function sd(n,t,e=!1){const i=n.children,s=t.children;if(Dt(i)&&Dt(s))for(let r=0;r<i.length;r++){const o=i[r];let a=s[r];a.shapeFlag&1&&!a.dynamicChildren&&((a.patchFlag<=0||a.patchFlag===32)&&(a=s[r]=ii(s[r]),a.el=o.el),!e&&a.patchFlag!==-2&&sd(o,a)),a.type===Qo&&(a.patchFlag===-1&&(a=s[r]=ii(a)),a.el=o.el),a.type===Tn&&!a.el&&(a.el=o.el)}}function Ym(n){const t=n.slice(),e=[0];let i,s,r,o,a;const l=n.length;for(i=0;i<l;i++){const u=n[i];if(u!==0){if(s=e[e.length-1],n[s]<u){t[i]=s,e.push(i);continue}for(r=0,o=e.length-1;r<o;)a=r+o>>1,n[e[a]]<u?r=a+1:o=a;u<n[e[r]]&&(r>0&&(t[i]=e[r-1]),e[r]=i)}}for(r=e.length,o=e[r-1];r-- >0;)e[r]=o,o=t[o];return e}function rd(n){const t=n.subTree.component;if(t)return t.asyncDep&&!t.asyncResolved?t:rd(t)}function yu(n){if(n)for(let t=0;t<n.length;t++)n[t].flags|=8}function pl(n){if(n.placeholder)return n.placeholder;const t=n.component;return t?pl(t.subTree):null}const od=n=>n.__isSuspense;function jm(n,t){t&&t.pendingBranch?Dt(n)?t.effects.push(...n):t.effects.push(n):nm(n)}const We=Symbol.for("v-fgt"),Qo=Symbol.for("v-txt"),Tn=Symbol.for("v-cmt"),va=Symbol.for("v-stc"),Qi=[];let Ze=null;function nn(n=!1){Qi.push(Ze=n?null:[])}function ad(){Qi.pop(),Ze=Qi[Qi.length-1]||null}let xr=1;function No(n,t=!1){xr+=n,n<0&&Ze&&t&&(Ze.hasOnce=!0)}function ld(n){return n.dynamicChildren=xr>0?Ze||Ki:null,ad(),xr>0&&Ze&&Ze.push(n),n}function _n(n,t,e,i,s,r){return ld(Ot(n,t,e,i,s,r,!0))}function Km(n,t,e,i,s){return ld(Xe(n,t,e,i,s,!0))}function yr(n){return n?n.__v_isVNode===!0:!1}function Ys(n,t){return n.type===t.type&&n.key===t.key}const cd=({key:n})=>n??null,mo=({ref:n,ref_key:t,ref_for:e})=>(typeof n=="number"&&(n=""+n),n!=null?ve(n)||Le(n)||Ht(n)?{i:ln,r:n,k:t,f:!!e}:n:null);function Ot(n,t=null,e=null,i=0,s=null,r=n===We?0:1,o=!1,a=!1){const l={__v_isVNode:!0,__v_skip:!0,type:n,props:t,key:t&&cd(t),ref:t&&mo(t),scopeId:Of,slotScopeIds:null,children:e,component:null,suspense:null,ssContent:null,ssFallback:null,dirs:null,transition:null,el:null,anchor:null,target:null,targetStart:null,targetAnchor:null,staticCount:0,shapeFlag:r,patchFlag:i,dynamicProps:s,dynamicChildren:null,appContext:null,ctx:ln};return a?(Oo(l,e),r&128&&n.normalize(l)):e&&(l.shapeFlag|=ve(e)?8:16),xr>0&&!o&&Ze&&(l.patchFlag>0||r&6)&&l.patchFlag!==32&&Ze.push(l),l}const Xe=$m;function $m(n,t=null,e=null,i=0,s=null,r=!1){if((!n||n===Mm)&&(n=Tn),yr(n)){const a=Is(n,t,!0);return e&&Oo(a,e),xr>0&&!r&&Ze&&(a.shapeFlag&6?Ze[Ze.indexOf(n)]=a:Ze.push(a)),a.patchFlag=-2,a}if(a_(n)&&(n=n.__vccOpts),t){t=Zm(t);let{class:a,style:l}=t;a&&!ve(a)&&(t.class=pc(a)),oe(l)&&(Sc(l)&&!Dt(l)&&(l=we({},l)),t.style=Yo(l))}const o=ve(n)?1:od(n)?128:$o(n)?64:oe(n)?4:Ht(n)?2:0;return Ot(n,t,e,i,s,o,r,!0)}function Zm(n){return n?Sc(n)||Jf(n)?we({},n):n:null}function Is(n,t,e=!1,i=!1){const{props:s,ref:r,patchFlag:o,children:a,transition:l}=n,u=t?Jm(s||{},t):s,c={__v_isVNode:!0,__v_skip:!0,type:n.type,props:u,key:u&&cd(u),ref:t&&t.ref?e&&r?Dt(r)?r.concat(mo(t)):[r,mo(t)]:mo(t):r,scopeId:n.scopeId,slotScopeIds:n.slotScopeIds,children:a,target:n.target,targetStart:n.targetStart,targetAnchor:n.targetAnchor,staticCount:n.staticCount,shapeFlag:n.shapeFlag,patchFlag:t&&n.type!==We?o===-1?16:o|16:o,dynamicProps:n.dynamicProps,dynamicChildren:n.dynamicChildren,appContext:n.appContext,dirs:n.dirs,transition:l,component:n.component,suspense:n.suspense,ssContent:n.ssContent&&Is(n.ssContent),ssFallback:n.ssFallback&&Is(n.ssFallback),placeholder:n.placeholder,el:n.el,anchor:n.anchor,ctx:n.ctx,ce:n.ce,cacheIndex:n.cacheIndex};return l&&i&&Lo(c,l.clone(c)),c}function _o(n=" ",t=0){return Xe(Qo,null,n,t)}function Wi(n="",t=!1){return t?(nn(),Km(Tn,null,n)):Xe(Tn,null,n)}function Pn(n){return n==null||typeof n=="boolean"?Xe(Tn):Dt(n)?Xe(We,null,n.slice()):yr(n)?ii(n):Xe(Qo,null,String(n))}function ii(n){return n.el===null&&n.patchFlag!==-1||n.memo?n:Is(n)}function Oo(n,t){let e=0;const{shapeFlag:i}=n;if(t==null)t=null;else if(Dt(t))e=16;else if(typeof t=="object")if(i&65){const s=t.default;s&&(s._c&&(s._d=!1),Oo(n,s()),s._c&&(s._d=!0));return}else{e=32;const s=t._;!s&&!Jf(t)?t._ctx=ln:s===3&&ln&&(ln.slots._===1?t._=1:(t._=2,n.patchFlag|=1024))}else if(Ht(t)){if(i&65){Oo(n,{default:t});return}t={default:t,_ctx:ln},e=32}else t=String(t),i&64?(e=16,t=[_o(t)]):e=8;n.children=t,n.shapeFlag|=e}function Jm(...n){const t={};for(let e=0;e<n.length;e++){const i=n[e];for(const s in i)if(s==="class")t.class!==i.class&&(t.class=pc([t.class,i.class]));else if(s==="style")t.style=Yo([t.style,i.style]);else if(Vo(s)){const r=t[s],o=i[s];o&&r!==o&&!(Dt(r)&&r.includes(o))?t[s]=r?[].concat(r,o):o:o==null&&r==null&&!Go(s)&&(t[s]=o)}else s!==""&&(t[s]=i[s])}return t}function wn(n,t,e,i=null){bn(n,t,7,[e,i])}const Qm=qf();let ud=0;function t_(){return ud}function e_(n,t,e){const i=n.type,s=(t?t.appContext:n.appContext)||Qm,r={uid:ud++,vnode:n,type:i,parent:t,appContext:s,root:null,next:null,subTree:null,effect:null,update:null,job:null,scope:new wp(!0),render:null,proxy:null,exposed:null,exposeProxy:null,withProxy:null,provides:t?t.provides:Object.create(s.provides),ids:t?t.ids:["",0,0],accessCache:null,renderCache:[],components:null,directives:null,propsOptions:td(i,s),emitsOptions:Yf(i,s),emit:null,emitted:null,propsDefaults:ce,inheritAttrs:i.inheritAttrs,ctx:ce,data:ce,props:ce,attrs:ce,slots:ce,refs:ce,setupState:ce,setupContext:null,suspense:e,suspenseId:e?e.pendingId:0,asyncDep:null,asyncResolved:!1,isMounted:!1,isUnmounted:!1,isDeactivated:!1,bc:null,c:null,bm:null,m:null,bu:null,u:null,um:null,bum:null,da:null,a:null,rtg:null,rtc:null,ec:null,sp:null};return r.ctx={_:r},r.root=t?t.root:r,r.emit=Lm.bind(null,r),n.ce&&n.ce(r),r}let Be=null;const n_=()=>Be||ln;let Fo,Mr;{const n=qo(),t=(e,i)=>{let s;return(s=n[e])||(s=n[e]=[]),s.push(i),r=>{s.length>1?s.forEach(o=>o(r)):s[0](r)}};Fo=t("__VUE_INSTANCE_SETTERS__",e=>Be=e),Mr=t("__VUE_SSR_SETTERS__",e=>Sr=e)}const Rr=n=>{const t=Be;return Fo(n),n.scope.on(),()=>{n.scope.off(),Fo(t)}},Mu=()=>{Be&&Be.scope.off(),Fo(null)};function hd(n){return n.vnode.shapeFlag&4}let Sr=!1;function i_(n,t=!1,e=!1){t&&Mr(t);const{props:i,children:s}=n.vnode,r=hd(n);Bm(n,i,r,t),Vm(n,s,e||t);const o=r?s_(n,t):void 0;return t&&Mr(!1),o}function s_(n,t){const e=n.type;n.accessCache=Object.create(null),n.proxy=new Proxy(n.ctx,Em);const{setup:i}=e;if(i){kn();const s=n.setupContext=i.length>1?o_(n):null,r=Rr(n),o=wr(i,n,0,[n.props,s]),a=of(o);if(Hn(),r(),(a||n.sp)&&!fr(n)&&kf(n),a){if(o.then(Mu,Mu),t)return o.then(l=>{Mr(!0);try{Su(n,l,t)}finally{Mr(!1)}}).catch(l=>{Ko(l,n,0)});n.asyncDep=o}else Su(n,o)}else fd(n)}function Su(n,t,e){Ht(t)?n.type.__ssrInlineRender?n.ssrRender=t:n.render=t:oe(t)&&(n.setupState=Cf(t)),fd(n)}function fd(n,t,e){const i=n.type;n.render||(n.render=i.render||Fn);{const s=Rr(n);kn();try{bm(n)}finally{Hn(),s()}}}const r_={get(n,t){return De(n,"get",""),n[t]}};function o_(n){const t=e=>{n.exposed=e||{}};return{attrs:new Proxy(n.attrs,r_),slots:n.slots,emit:n.emit,expose:t}}function ta(n){return n.exposed?n.exposeProxy||(n.exposeProxy=new Proxy(Cf(qp(n.exposed)),{get(t,e){if(e in t)return t[e];if(e in dr)return dr[e](n)},has(t,e){return e in t||e in dr}})):n.proxy}function a_(n){return Ht(n)&&"__vccOpts"in n}const ts=(n,t)=>Zp(n,t,Sr);function Br(n,t,e){try{No(-1);const i=arguments.length;return i===2?oe(t)&&!Dt(t)?yr(t)?Xe(n,null,[t]):Xe(n,t):Xe(n,null,t):(i>3?e=Array.prototype.slice.call(arguments,2):i===3&&yr(e)&&(e=[e]),Xe(n,t,e))}finally{No(1)}}const l_="3.5.44";/**
* @vue/runtime-dom v3.5.44
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/let ml;const Eu=typeof window<"u"&&window.trustedTypes;if(Eu)try{ml=Eu.createPolicy("vue",{createHTML:n=>n})}catch{}const dd=ml?n=>ml.createHTML(n):n=>n,c_="http://www.w3.org/2000/svg",u_="http://www.w3.org/1998/Math/MathML",ni=typeof document<"u"?document:null,bu=ni&&ni.createElement("template"),h_={insert:(n,t,e)=>{t.insertBefore(n,e||null)},remove:n=>{const t=n.parentNode;t&&t.removeChild(n)},createElement:(n,t,e,i)=>{const s=t==="svg"?ni.createElementNS(c_,n):t==="mathml"?ni.createElementNS(u_,n):e?ni.createElement(n,{is:e}):ni.createElement(n);return n==="select"&&i&&i.multiple!=null&&s.setAttribute("multiple",i.multiple),s},createText:n=>ni.createTextNode(n),createComment:n=>ni.createComment(n),setText:(n,t)=>{n.nodeValue=t},setElementText:(n,t)=>{n.textContent=t},parentNode:n=>n.parentNode,nextSibling:n=>n.nextSibling,querySelector:n=>ni.querySelector(n),setScopeId(n,t){n.setAttribute(t,"")},insertStaticContent(n,t,e,i,s,r){const o=e?e.previousSibling:t.lastChild;if(s&&(s===r||s.nextSibling))for(;t.insertBefore(s.cloneNode(!0),e),!(s===r||!(s=s.nextSibling)););else{bu.innerHTML=dd(i==="svg"?`<svg>${n}</svg>`:i==="mathml"?`<math>${n}</math>`:n);const a=bu.content;if(i==="svg"||i==="mathml"){const l=a.firstChild;for(;l.firstChild;)a.appendChild(l.firstChild);a.removeChild(l)}t.insertBefore(a,e)}return[o?o.nextSibling:t.firstChild,e?e.previousSibling:t.lastChild]}},f_=Symbol("_vtc");function d_(n,t,e){const i=n[f_];i&&(t=(t?[t,...i]:[...i]).join(" ")),t==null?n.removeAttribute("class"):e?n.setAttribute("class",t):n.className=t}const Tu=Symbol("_vod"),p_=Symbol("_vsh"),m_=Symbol(""),__=/(?:^|;)\s*display\s*:/;function g_(n,t,e){const i=n.style,s=ve(e);let r=!1;if(e&&!s){if(t)if(ve(t))for(const o of t.split(";")){const a=o.slice(0,o.indexOf(":")).trim();e[a]==null&&ir(i,a,"")}else for(const o in t)e[o]==null&&ir(i,o,"");for(const o in e){o==="display"&&(r=!0);const a=e[o];a!=null?x_(n,o,!ve(t)&&t?t[o]:void 0,a)||ir(i,o,a):ir(i,o,"")}}else if(s){if(t!==e){const o=i[m_];o&&(e+=";"+o),i.cssText=e,r=__.test(e)}}else t&&n.removeAttribute("style");Tu in n&&((!s||t!==e)&&(n[Tu]=r?i.display:""),n[p_]&&(i.display="none"))}const zr=/\s*!important$/;function ir(n,t,e){if(Dt(e))e.forEach(i=>ir(n,t,i));else if(e==null&&(e=""),t.startsWith("--"))zr.test(e)?n.setProperty(t,e.replace(zr,""),"important"):n.setProperty(t,e);else{const i=v_(n,t);zr.test(e)?n.setProperty(ss(i),e.replace(zr,""),"important"):n[i]=e}}const Au=["Webkit","Moz","ms"],xa={};function v_(n,t){const e=xa[t];if(e)return e;let i=Mn(t);if(i!=="filter"&&i in n)return xa[t]=i;i=cf(i);for(let s=0;s<Au.length;s++){const r=Au[s]+i;if(r in n)return xa[t]=r}return t}function x_(n,t,e,i){return n.tagName==="TEXTAREA"&&(t==="width"||t==="height")&&ve(i)&&e===i}const wu="http://www.w3.org/1999/xlink";function Ru(n,t,e,i,s,r=bp(t)){i&&t.startsWith("xlink:")?e==null?n.removeAttributeNS(wu,t.slice(6,t.length)):n.setAttributeNS(wu,t,e):e==null||r&&!hf(e)?n.removeAttribute(t):n.setAttribute(t,r?"":zn(e)?String(e):e)}function Cu(n,t,e,i,s){if(t==="innerHTML"||t==="textContent"){e!=null&&(n[t]=t==="innerHTML"?dd(e):e);return}const r=n.tagName;if(t==="value"&&r!=="PROGRESS"&&!r.includes("-")){const a=r==="OPTION"?n.getAttribute("value")||"":n.value,l=e==null?n.type==="checkbox"?"on":"":String(e);(a!==l||!("_value"in n))&&(n.value=l),e==null&&n.removeAttribute(t),n._value=e;return}let o=!1;if(e===""||e==null){const a=typeof n[t];a==="boolean"?e=hf(e):e==null&&a==="string"?(e="",o=!0):a==="number"&&(e=0,o=!0)}try{n[t]=e}catch{}o&&n.removeAttribute(s||t)}function Si(n,t,e,i){n.addEventListener(t,e,i)}function y_(n,t,e,i){n.removeEventListener(t,e,i)}const Pu=Symbol("_vei");function M_(n,t,e,i,s=null){const r=n[Pu]||(n[Pu]={}),o=r[t];if(i&&o)o.value=i;else{const[a,l]=b_(t);if(i){const u=r[t]=w_(i,s);Si(n,a,u,l)}else o&&(y_(n,a,o,l),r[t]=void 0)}}const S_=/(Once|Passive|Capture)$/,E_=/^on:?(?:Once|Passive|Capture)$/;function b_(n){let t,e;for(;(e=n.match(S_))&&!E_.test(n);)t||(t={}),n=n.slice(0,n.length-e[1].length),t[e[1].toLowerCase()]=!0;return[n[2]===":"?n.slice(3):ss(n.slice(2)),t]}let ya=0;const T_=Promise.resolve(),A_=()=>ya||(T_.then(()=>ya=0),ya=Date.now());function w_(n,t){const e=i=>{if(!i._vts)i._vts=Date.now();else if(i._vts<=e.attached)return;const s=e.value;if(Dt(s)){const r=i.stopImmediatePropagation;i.stopImmediatePropagation=()=>{r.call(i),i._stopped=!0};const o=s.slice(),a=[i];for(let l=0;l<o.length&&!i._stopped;l++){const u=o[l];u&&bn(u,t,5,a)}}else bn(s,t,5,[i])};return e.value=n,e.attached=A_(),e}const Du=n=>n.charCodeAt(0)===111&&n.charCodeAt(1)===110&&n.charCodeAt(2)>96&&n.charCodeAt(2)<123,R_=(n,t,e,i,s,r)=>{const o=s==="svg";t==="class"?d_(n,i,o):t==="style"?g_(n,e,i):Vo(t)?Go(t)||M_(n,t,e,i,r):(t[0]==="."?(t=t.slice(1),!0):t[0]==="^"?(t=t.slice(1),!1):C_(n,t,i,o))?(Cu(n,t,i),!n.tagName.includes("-")&&(t==="value"||t==="checked"||t==="selected")&&Ru(n,t,i,o,r,t!=="value")):n._isVueCE&&(P_(n,t)||n._def.__asyncLoader&&(/[A-Z]/.test(t)||!ve(i)))?Cu(n,Mn(t),i,r,t):(t==="true-value"?n._trueValue=i:t==="false-value"&&(n._falseValue=i),Ru(n,t,i,o))};function C_(n,t,e,i){if(i)return!!(t==="innerHTML"||t==="textContent"||t in n&&Du(t)&&Ht(e));if(t==="spellcheck"||t==="draggable"||t==="translate"||t==="autocorrect"||t==="sandbox"&&n.tagName==="IFRAME"||t==="form"||t==="list"&&n.tagName==="INPUT"||t==="type"&&n.tagName==="TEXTAREA")return!1;if(t==="width"||t==="height"){const s=n.tagName;if(s==="IMG"||s==="VIDEO"||s==="CANVAS"||s==="SOURCE")return!1}return Du(t)&&ve(e)?!1:t in n}function P_(n,t){const e=n._def.props;if(!e)return!1;const i=Mn(t);return Array.isArray(e)?e.some(s=>Mn(s)===i):Object.keys(e).some(s=>Mn(s)===i)}const Us=n=>{const t=n.props["onUpdate:modelValue"]||!1;return Dt(t)?e=>fo(t,e):t};function D_(n){n.target.composing=!0}function Lu(n){const t=n.target;t.composing&&(t.composing=!1,t.dispatchEvent(new Event("input")))}const Un=Symbol("_assign"),kr=Symbol("_initialValue");function Ma(n,t,e){return t&&(n=n.trim()),e&&(n=Xo(n)),n}const Sa={created(n,{modifiers:{lazy:t,trim:e,number:i}},s){n.parentNode&&(n.type==="text"?n[kr]=n.defaultValue.replace(/[\r\n]/g,""):n.type==="textarea"&&(n[kr]=n.defaultValue.replace(/\r\n?/g,`
`))),n[Un]=Us(s);const r=i||s.props&&s.props.type==="number";Si(n,t?"change":"input",o=>{o.target.composing||n[Un](Ma(n.value,e,r))}),(e||r)&&Si(n,"change",()=>{n.value=Ma(n.value,e,r)}),t||(Si(n,"compositionstart",D_),Si(n,"compositionend",Lu),Si(n,"change",Lu))},mounted(n,{value:t,modifiers:{trim:e,number:i}}){const s=t??"",r=n[kr];delete n[kr],r!==void 0&&(n.type==="text"||n.type==="textarea")&&n.value!==r?n[Un](Ma(n.value,e,i)):n.value=s},beforeUpdate(n,{value:t,oldValue:e,modifiers:{lazy:i,trim:s,number:r}},o){if(n[Un]=Us(o),n.composing)return;const a=(r||n.type==="number")&&!/^0\d/.test(n.value)?Xo(n.value):n.value,l=t??"";if(a===l)return;const u=n.getRootNode();(u instanceof Document||u instanceof ShadowRoot)&&u.activeElement===n&&n.type!=="range"&&(i&&t===e||s&&n.value.trim()===l)||(n.value=l)}},Iu={deep:!0,created(n,t,e){n[Un]=Us(e),Si(n,"change",()=>{const i=n._modelValue,s=Er(n),r=n.checked,o=n[Un];if(Dt(i)){const a=mc(i,s),l=a!==-1;if(r&&!l)o(i.concat(s));else if(!r&&l){const u=[...i];u.splice(a,1),o(u)}}else if(li(i)){const a=new Set(i);r?a.add(s):a.delete(s),o(a)}else o(pd(n,r))})},mounted:Uu,beforeUpdate(n,t,e){n[Un]=Us(e),Uu(n,t,e)}};function Uu(n,{value:t,oldValue:e},i){n._modelValue=t;let s;if(Dt(t))s=mc(t,i.props.value)>-1;else if(li(t))s=t.has(i.props.value);else{if(t===e)return;s=ci(t,pd(n,!0))}n.checked!==s&&(n.checked=s)}const Nu={deep:!0,created(n,{value:t,modifiers:{number:e}},i){n._modelValue=t,Si(n,"change",()=>{const s=Array.prototype.filter.call(n.options,l=>l.selected).map(l=>e?Xo(Er(l)):Er(l)),r=n.multiple,o=r?li(n._modelValue)?new Set(s):s:s[0],a=n._pendingValue=[r,r?Dt(o)?s.slice():s:o];try{n[Un](o)}finally{Df(()=>{n._pendingValue===a&&(n._pendingValue=void 0)})}}),n[Un]=Us(i)},mounted(n,{value:t}){Ou(n,t)},beforeUpdate(n,{value:t},e){n._modelValue=t,n[Un]=Us(e)},updated(n,{value:t}){const e=n._pendingValue;n._pendingValue=void 0,(!e||e[0]!==n.multiple||!L_(t,e[1],e[0]))&&Ou(n,t)}};function L_(n,t,e){if(!e||Dt(n))return ci(n,t);if(li(n)){if(n.size!==t.length)return!1;for(const i of t)if(!n.has(i))return!1;return!0}return!1}function Ou(n,t){const e=n.multiple,i=Dt(t);if(!(e&&!i&&!li(t))){for(let s=0,r=n.options.length;s<r;s++){const o=n.options[s],a=Er(o);if(e)if(i){const l=typeof a;l==="string"||l==="number"?o.selected=t.some(u=>String(u)===String(a)):o.selected=mc(t,a)>-1}else o.selected=t.has(a);else if(ci(Er(o),t)){n.selectedIndex!==s&&(n.selectedIndex=s);return}}!e&&n.selectedIndex!==-1&&(n.selectedIndex=-1)}}function Er(n){return"_value"in n?n._value:n.value}function pd(n,t){const e=t?"_trueValue":"_falseValue";return e in n?n[e]:t}const I_=we({patchProp:R_},h_);let Fu;function U_(){return Fu||(Fu=Wm(I_))}const N_=((...n)=>{const t=U_().createApp(...n),{mount:e}=t;return t.mount=i=>{const s=F_(i);if(!s)return;const r=t._component;!Ht(r)&&!r.render&&!r.template&&(r.template=s.innerHTML),s.nodeType===1&&(s.textContent="");const o=e(s,!1,O_(s));return s instanceof Element&&(s.removeAttribute("v-cloak"),s.setAttribute("data-v-app","")),o},t});function O_(n){if(n instanceof SVGElement)return"svg";if(typeof MathMLElement=="function"&&n instanceof MathMLElement)return"mathml"}function F_(n){return ve(n)?document.querySelector(n):n}/**
 * @license
 * Copyright 2010-2024 Three.js Authors
 * SPDX-License-Identifier: MIT
 */const ea="170",Cs={ROTATE:0,DOLLY:1,PAN:2},As={ROTATE:0,PAN:1,DOLLY_PAN:2,DOLLY_ROTATE:3},B_=0,Bu=1,z_=2,md=1,k_=2,ei=3,Pi=0,Ye=1,In=2,wi=0,Ps=1,zu=2,ku=3,Hu=4,H_=5,qi=100,V_=101,G_=102,W_=103,X_=104,q_=200,Y_=201,j_=202,K_=203,_l=204,gl=205,$_=206,Z_=207,J_=208,Q_=209,tg=210,eg=211,ng=212,ig=213,sg=214,vl=0,xl=1,yl=2,Ns=3,Ml=4,Sl=5,El=6,bl=7,Cc=0,rg=1,og=2,Ri=0,ag=1,lg=2,cg=3,ug=4,hg=5,fg=6,dg=7,_d=300,Os=301,Fs=302,Tl=303,Al=304,na=306,wl=1e3,$i=1001,Rl=1002,Je=1003,pg=1004,Hr=1005,Nn=1006,Ea=1007,Zi=1008,ui=1009,gd=1010,vd=1011,br=1012,Pc=1013,es=1014,On=1015,Cr=1016,Dc=1017,Lc=1018,Bs=1020,xd=35902,yd=1021,Md=1022,yn=1023,Sd=1024,Ed=1025,Ds=1026,zs=1027,Ic=1028,Uc=1029,bd=1030,Nc=1031,Oc=1033,go=33776,vo=33777,xo=33778,yo=33779,Cl=35840,Pl=35841,Dl=35842,Ll=35843,Il=36196,Ul=37492,Nl=37496,Ol=37808,Fl=37809,Bl=37810,zl=37811,kl=37812,Hl=37813,Vl=37814,Gl=37815,Wl=37816,Xl=37817,ql=37818,Yl=37819,jl=37820,Kl=37821,Mo=36492,$l=36494,Zl=36495,Td=36283,Jl=36284,Ql=36285,tc=36286,mg=3200,_g=3201,Ad=0,gg=1,Ei="",rn="srgb",Hs="srgb-linear",ia="linear",ae="srgb",cs=7680,Vu=519,vg=512,xg=513,yg=514,wd=515,Mg=516,Sg=517,Eg=518,bg=519,Gu=35044,Tg=35048,Wu="300 es",oi=2e3,Bo=2001;class rs{addEventListener(t,e){this._listeners===void 0&&(this._listeners={});const i=this._listeners;i[t]===void 0&&(i[t]=[]),i[t].indexOf(e)===-1&&i[t].push(e)}hasEventListener(t,e){if(this._listeners===void 0)return!1;const i=this._listeners;return i[t]!==void 0&&i[t].indexOf(e)!==-1}removeEventListener(t,e){if(this._listeners===void 0)return;const s=this._listeners[t];if(s!==void 0){const r=s.indexOf(e);r!==-1&&s.splice(r,1)}}dispatchEvent(t){if(this._listeners===void 0)return;const i=this._listeners[t.type];if(i!==void 0){t.target=this;const s=i.slice(0);for(let r=0,o=s.length;r<o;r++)s[r].call(this,t);t.target=null}}}const Ce=["00","01","02","03","04","05","06","07","08","09","0a","0b","0c","0d","0e","0f","10","11","12","13","14","15","16","17","18","19","1a","1b","1c","1d","1e","1f","20","21","22","23","24","25","26","27","28","29","2a","2b","2c","2d","2e","2f","30","31","32","33","34","35","36","37","38","39","3a","3b","3c","3d","3e","3f","40","41","42","43","44","45","46","47","48","49","4a","4b","4c","4d","4e","4f","50","51","52","53","54","55","56","57","58","59","5a","5b","5c","5d","5e","5f","60","61","62","63","64","65","66","67","68","69","6a","6b","6c","6d","6e","6f","70","71","72","73","74","75","76","77","78","79","7a","7b","7c","7d","7e","7f","80","81","82","83","84","85","86","87","88","89","8a","8b","8c","8d","8e","8f","90","91","92","93","94","95","96","97","98","99","9a","9b","9c","9d","9e","9f","a0","a1","a2","a3","a4","a5","a6","a7","a8","a9","aa","ab","ac","ad","ae","af","b0","b1","b2","b3","b4","b5","b6","b7","b8","b9","ba","bb","bc","bd","be","bf","c0","c1","c2","c3","c4","c5","c6","c7","c8","c9","ca","cb","cc","cd","ce","cf","d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","da","db","dc","dd","de","df","e0","e1","e2","e3","e4","e5","e6","e7","e8","e9","ea","eb","ec","ed","ee","ef","f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","fa","fb","fc","fd","fe","ff"],So=Math.PI/180,ec=180/Math.PI;function Pr(){const n=Math.random()*4294967295|0,t=Math.random()*4294967295|0,e=Math.random()*4294967295|0,i=Math.random()*4294967295|0;return(Ce[n&255]+Ce[n>>8&255]+Ce[n>>16&255]+Ce[n>>24&255]+"-"+Ce[t&255]+Ce[t>>8&255]+"-"+Ce[t>>16&15|64]+Ce[t>>24&255]+"-"+Ce[e&63|128]+Ce[e>>8&255]+"-"+Ce[e>>16&255]+Ce[e>>24&255]+Ce[i&255]+Ce[i>>8&255]+Ce[i>>16&255]+Ce[i>>24&255]).toLowerCase()}function Fe(n,t,e){return Math.max(t,Math.min(e,n))}function Ag(n,t){return(n%t+t)%t}function ba(n,t,e){return(1-e)*n+e*t}function js(n,t){switch(t.constructor){case Float32Array:return n;case Uint32Array:return n/4294967295;case Uint16Array:return n/65535;case Uint8Array:return n/255;case Int32Array:return Math.max(n/2147483647,-1);case Int16Array:return Math.max(n/32767,-1);case Int8Array:return Math.max(n/127,-1);default:throw new Error("Invalid component type.")}}function He(n,t){switch(t.constructor){case Float32Array:return n;case Uint32Array:return Math.round(n*4294967295);case Uint16Array:return Math.round(n*65535);case Uint8Array:return Math.round(n*255);case Int32Array:return Math.round(n*2147483647);case Int16Array:return Math.round(n*32767);case Int8Array:return Math.round(n*127);default:throw new Error("Invalid component type.")}}const wg={DEG2RAD:So};class kt{constructor(t=0,e=0){kt.prototype.isVector2=!0,this.x=t,this.y=e}get width(){return this.x}set width(t){this.x=t}get height(){return this.y}set height(t){this.y=t}set(t,e){return this.x=t,this.y=e,this}setScalar(t){return this.x=t,this.y=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y)}copy(t){return this.x=t.x,this.y=t.y,this}add(t){return this.x+=t.x,this.y+=t.y,this}addScalar(t){return this.x+=t,this.y+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this}subScalar(t){return this.x-=t,this.y-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this}multiply(t){return this.x*=t.x,this.y*=t.y,this}multiplyScalar(t){return this.x*=t,this.y*=t,this}divide(t){return this.x/=t.x,this.y/=t.y,this}divideScalar(t){return this.multiplyScalar(1/t)}applyMatrix3(t){const e=this.x,i=this.y,s=t.elements;return this.x=s[0]*e+s[3]*i+s[6],this.y=s[1]*e+s[4]*i+s[7],this}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this}clampLength(t,e){const i=this.length();return this.divideScalar(i||1).multiplyScalar(Math.max(t,Math.min(e,i)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this}negate(){return this.x=-this.x,this.y=-this.y,this}dot(t){return this.x*t.x+this.y*t.y}cross(t){return this.x*t.y-this.y*t.x}lengthSq(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.x*this.x+this.y*this.y)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)}normalize(){return this.divideScalar(this.length()||1)}angle(){return Math.atan2(-this.y,-this.x)+Math.PI}angleTo(t){const e=Math.sqrt(this.lengthSq()*t.lengthSq());if(e===0)return Math.PI/2;const i=this.dot(t)/e;return Math.acos(Fe(i,-1,1))}distanceTo(t){return Math.sqrt(this.distanceToSquared(t))}distanceToSquared(t){const e=this.x-t.x,i=this.y-t.y;return e*e+i*i}manhattanDistanceTo(t){return Math.abs(this.x-t.x)+Math.abs(this.y-t.y)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this}lerpVectors(t,e,i){return this.x=t.x+(e.x-t.x)*i,this.y=t.y+(e.y-t.y)*i,this}equals(t){return t.x===this.x&&t.y===this.y}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this}rotateAround(t,e){const i=Math.cos(e),s=Math.sin(e),r=this.x-t.x,o=this.y-t.y;return this.x=r*i-o*s+t.x,this.y=r*s+o*i+t.y,this}random(){return this.x=Math.random(),this.y=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y}}class Wt{constructor(t,e,i,s,r,o,a,l,u){Wt.prototype.isMatrix3=!0,this.elements=[1,0,0,0,1,0,0,0,1],t!==void 0&&this.set(t,e,i,s,r,o,a,l,u)}set(t,e,i,s,r,o,a,l,u){const c=this.elements;return c[0]=t,c[1]=s,c[2]=a,c[3]=e,c[4]=r,c[5]=l,c[6]=i,c[7]=o,c[8]=u,this}identity(){return this.set(1,0,0,0,1,0,0,0,1),this}copy(t){const e=this.elements,i=t.elements;return e[0]=i[0],e[1]=i[1],e[2]=i[2],e[3]=i[3],e[4]=i[4],e[5]=i[5],e[6]=i[6],e[7]=i[7],e[8]=i[8],this}extractBasis(t,e,i){return t.setFromMatrix3Column(this,0),e.setFromMatrix3Column(this,1),i.setFromMatrix3Column(this,2),this}setFromMatrix4(t){const e=t.elements;return this.set(e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]),this}multiply(t){return this.multiplyMatrices(this,t)}premultiply(t){return this.multiplyMatrices(t,this)}multiplyMatrices(t,e){const i=t.elements,s=e.elements,r=this.elements,o=i[0],a=i[3],l=i[6],u=i[1],c=i[4],h=i[7],d=i[2],p=i[5],g=i[8],v=s[0],m=s[3],f=s[6],w=s[1],b=s[4],x=s[7],B=s[2],P=s[5],D=s[8];return r[0]=o*v+a*w+l*B,r[3]=o*m+a*b+l*P,r[6]=o*f+a*x+l*D,r[1]=u*v+c*w+h*B,r[4]=u*m+c*b+h*P,r[7]=u*f+c*x+h*D,r[2]=d*v+p*w+g*B,r[5]=d*m+p*b+g*P,r[8]=d*f+p*x+g*D,this}multiplyScalar(t){const e=this.elements;return e[0]*=t,e[3]*=t,e[6]*=t,e[1]*=t,e[4]*=t,e[7]*=t,e[2]*=t,e[5]*=t,e[8]*=t,this}determinant(){const t=this.elements,e=t[0],i=t[1],s=t[2],r=t[3],o=t[4],a=t[5],l=t[6],u=t[7],c=t[8];return e*o*c-e*a*u-i*r*c+i*a*l+s*r*u-s*o*l}invert(){const t=this.elements,e=t[0],i=t[1],s=t[2],r=t[3],o=t[4],a=t[5],l=t[6],u=t[7],c=t[8],h=c*o-a*u,d=a*l-c*r,p=u*r-o*l,g=e*h+i*d+s*p;if(g===0)return this.set(0,0,0,0,0,0,0,0,0);const v=1/g;return t[0]=h*v,t[1]=(s*u-c*i)*v,t[2]=(a*i-s*o)*v,t[3]=d*v,t[4]=(c*e-s*l)*v,t[5]=(s*r-a*e)*v,t[6]=p*v,t[7]=(i*l-u*e)*v,t[8]=(o*e-i*r)*v,this}transpose(){let t;const e=this.elements;return t=e[1],e[1]=e[3],e[3]=t,t=e[2],e[2]=e[6],e[6]=t,t=e[5],e[5]=e[7],e[7]=t,this}getNormalMatrix(t){return this.setFromMatrix4(t).invert().transpose()}transposeIntoArray(t){const e=this.elements;return t[0]=e[0],t[1]=e[3],t[2]=e[6],t[3]=e[1],t[4]=e[4],t[5]=e[7],t[6]=e[2],t[7]=e[5],t[8]=e[8],this}setUvTransform(t,e,i,s,r,o,a){const l=Math.cos(r),u=Math.sin(r);return this.set(i*l,i*u,-i*(l*o+u*a)+o+t,-s*u,s*l,-s*(-u*o+l*a)+a+e,0,0,1),this}scale(t,e){return this.premultiply(Ta.makeScale(t,e)),this}rotate(t){return this.premultiply(Ta.makeRotation(-t)),this}translate(t,e){return this.premultiply(Ta.makeTranslation(t,e)),this}makeTranslation(t,e){return t.isVector2?this.set(1,0,t.x,0,1,t.y,0,0,1):this.set(1,0,t,0,1,e,0,0,1),this}makeRotation(t){const e=Math.cos(t),i=Math.sin(t);return this.set(e,-i,0,i,e,0,0,0,1),this}makeScale(t,e){return this.set(t,0,0,0,e,0,0,0,1),this}equals(t){const e=this.elements,i=t.elements;for(let s=0;s<9;s++)if(e[s]!==i[s])return!1;return!0}fromArray(t,e=0){for(let i=0;i<9;i++)this.elements[i]=t[i+e];return this}toArray(t=[],e=0){const i=this.elements;return t[e]=i[0],t[e+1]=i[1],t[e+2]=i[2],t[e+3]=i[3],t[e+4]=i[4],t[e+5]=i[5],t[e+6]=i[6],t[e+7]=i[7],t[e+8]=i[8],t}clone(){return new this.constructor().fromArray(this.elements)}}const Ta=new Wt;function Rd(n){for(let t=n.length-1;t>=0;--t)if(n[t]>=65535)return!0;return!1}function zo(n){return document.createElementNS("http://www.w3.org/1999/xhtml",n)}function Rg(){const n=zo("canvas");return n.style.display="block",n}const Xu={};function sr(n){n in Xu||(Xu[n]=!0,console.warn(n))}function Cg(n,t,e){return new Promise(function(i,s){function r(){switch(n.clientWaitSync(t,n.SYNC_FLUSH_COMMANDS_BIT,0)){case n.WAIT_FAILED:s();break;case n.TIMEOUT_EXPIRED:setTimeout(r,e);break;default:i()}}setTimeout(r,e)})}function Pg(n){const t=n.elements;t[2]=.5*t[2]+.5*t[3],t[6]=.5*t[6]+.5*t[7],t[10]=.5*t[10]+.5*t[11],t[14]=.5*t[14]+.5*t[15]}function Dg(n){const t=n.elements;t[11]===-1?(t[10]=-t[10]-1,t[14]=-t[14]):(t[10]=-t[10],t[14]=-t[14]+1)}const Jt={enabled:!0,workingColorSpace:Hs,spaces:{},convert:function(n,t,e){return this.enabled===!1||t===e||!t||!e||(this.spaces[t].transfer===ae&&(n.r=ai(n.r),n.g=ai(n.g),n.b=ai(n.b)),this.spaces[t].primaries!==this.spaces[e].primaries&&(n.applyMatrix3(this.spaces[t].toXYZ),n.applyMatrix3(this.spaces[e].fromXYZ)),this.spaces[e].transfer===ae&&(n.r=Ls(n.r),n.g=Ls(n.g),n.b=Ls(n.b))),n},fromWorkingColorSpace:function(n,t){return this.convert(n,this.workingColorSpace,t)},toWorkingColorSpace:function(n,t){return this.convert(n,t,this.workingColorSpace)},getPrimaries:function(n){return this.spaces[n].primaries},getTransfer:function(n){return n===Ei?ia:this.spaces[n].transfer},getLuminanceCoefficients:function(n,t=this.workingColorSpace){return n.fromArray(this.spaces[t].luminanceCoefficients)},define:function(n){Object.assign(this.spaces,n)},_getMatrix:function(n,t,e){return n.copy(this.spaces[t].toXYZ).multiply(this.spaces[e].fromXYZ)},_getDrawingBufferColorSpace:function(n){return this.spaces[n].outputColorSpaceConfig.drawingBufferColorSpace},_getUnpackColorSpace:function(n=this.workingColorSpace){return this.spaces[n].workingColorSpaceConfig.unpackColorSpace}};function ai(n){return n<.04045?n*.0773993808:Math.pow(n*.9478672986+.0521327014,2.4)}function Ls(n){return n<.0031308?n*12.92:1.055*Math.pow(n,.41666)-.055}const qu=[.64,.33,.3,.6,.15,.06],Yu=[.2126,.7152,.0722],ju=[.3127,.329],Ku=new Wt().set(.4123908,.3575843,.1804808,.212639,.7151687,.0721923,.0193308,.1191948,.9505322),$u=new Wt().set(3.2409699,-1.5373832,-.4986108,-.9692436,1.8759675,.0415551,.0556301,-.203977,1.0569715);Jt.define({[Hs]:{primaries:qu,whitePoint:ju,transfer:ia,toXYZ:Ku,fromXYZ:$u,luminanceCoefficients:Yu,workingColorSpaceConfig:{unpackColorSpace:rn},outputColorSpaceConfig:{drawingBufferColorSpace:rn}},[rn]:{primaries:qu,whitePoint:ju,transfer:ae,toXYZ:Ku,fromXYZ:$u,luminanceCoefficients:Yu,outputColorSpaceConfig:{drawingBufferColorSpace:rn}}});let us;class Lg{static getDataURL(t){if(/^data:/i.test(t.src)||typeof HTMLCanvasElement>"u")return t.src;let e;if(t instanceof HTMLCanvasElement)e=t;else{us===void 0&&(us=zo("canvas")),us.width=t.width,us.height=t.height;const i=us.getContext("2d");t instanceof ImageData?i.putImageData(t,0,0):i.drawImage(t,0,0,t.width,t.height),e=us}return e.width>2048||e.height>2048?(console.warn("THREE.ImageUtils.getDataURL: Image converted to jpg for performance reasons",t),e.toDataURL("image/jpeg",.6)):e.toDataURL("image/png")}static sRGBToLinear(t){if(typeof HTMLImageElement<"u"&&t instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&t instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&t instanceof ImageBitmap){const e=zo("canvas");e.width=t.width,e.height=t.height;const i=e.getContext("2d");i.drawImage(t,0,0,t.width,t.height);const s=i.getImageData(0,0,t.width,t.height),r=s.data;for(let o=0;o<r.length;o++)r[o]=ai(r[o]/255)*255;return i.putImageData(s,0,0),e}else if(t.data){const e=t.data.slice(0);for(let i=0;i<e.length;i++)e instanceof Uint8Array||e instanceof Uint8ClampedArray?e[i]=Math.floor(ai(e[i]/255)*255):e[i]=ai(e[i]);return{data:e,width:t.width,height:t.height}}else return console.warn("THREE.ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."),t}}let Ig=0;class Cd{constructor(t=null){this.isSource=!0,Object.defineProperty(this,"id",{value:Ig++}),this.uuid=Pr(),this.data=t,this.dataReady=!0,this.version=0}set needsUpdate(t){t===!0&&this.version++}toJSON(t){const e=t===void 0||typeof t=="string";if(!e&&t.images[this.uuid]!==void 0)return t.images[this.uuid];const i={uuid:this.uuid,url:""},s=this.data;if(s!==null){let r;if(Array.isArray(s)){r=[];for(let o=0,a=s.length;o<a;o++)s[o].isDataTexture?r.push(Aa(s[o].image)):r.push(Aa(s[o]))}else r=Aa(s);i.url=r}return e||(t.images[this.uuid]=i),i}}function Aa(n){return typeof HTMLImageElement<"u"&&n instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&n instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&n instanceof ImageBitmap?Lg.getDataURL(n):n.data?{data:Array.from(n.data),width:n.width,height:n.height,type:n.data.constructor.name}:(console.warn("THREE.Texture: Unable to serialize Texture."),{})}let Ug=0;class ze extends rs{constructor(t=ze.DEFAULT_IMAGE,e=ze.DEFAULT_MAPPING,i=$i,s=$i,r=Nn,o=Zi,a=yn,l=ui,u=ze.DEFAULT_ANISOTROPY,c=Ei){super(),this.isTexture=!0,Object.defineProperty(this,"id",{value:Ug++}),this.uuid=Pr(),this.name="",this.source=new Cd(t),this.mipmaps=[],this.mapping=e,this.channel=0,this.wrapS=i,this.wrapT=s,this.magFilter=r,this.minFilter=o,this.anisotropy=u,this.format=a,this.internalFormat=null,this.type=l,this.offset=new kt(0,0),this.repeat=new kt(1,1),this.center=new kt(0,0),this.rotation=0,this.matrixAutoUpdate=!0,this.matrix=new Wt,this.generateMipmaps=!0,this.premultiplyAlpha=!1,this.flipY=!0,this.unpackAlignment=4,this.colorSpace=c,this.userData={},this.version=0,this.onUpdate=null,this.isRenderTargetTexture=!1,this.pmremVersion=0}get image(){return this.source.data}set image(t=null){this.source.data=t}updateMatrix(){this.matrix.setUvTransform(this.offset.x,this.offset.y,this.repeat.x,this.repeat.y,this.rotation,this.center.x,this.center.y)}clone(){return new this.constructor().copy(this)}copy(t){return this.name=t.name,this.source=t.source,this.mipmaps=t.mipmaps.slice(0),this.mapping=t.mapping,this.channel=t.channel,this.wrapS=t.wrapS,this.wrapT=t.wrapT,this.magFilter=t.magFilter,this.minFilter=t.minFilter,this.anisotropy=t.anisotropy,this.format=t.format,this.internalFormat=t.internalFormat,this.type=t.type,this.offset.copy(t.offset),this.repeat.copy(t.repeat),this.center.copy(t.center),this.rotation=t.rotation,this.matrixAutoUpdate=t.matrixAutoUpdate,this.matrix.copy(t.matrix),this.generateMipmaps=t.generateMipmaps,this.premultiplyAlpha=t.premultiplyAlpha,this.flipY=t.flipY,this.unpackAlignment=t.unpackAlignment,this.colorSpace=t.colorSpace,this.userData=JSON.parse(JSON.stringify(t.userData)),this.needsUpdate=!0,this}toJSON(t){const e=t===void 0||typeof t=="string";if(!e&&t.textures[this.uuid]!==void 0)return t.textures[this.uuid];const i={metadata:{version:4.6,type:"Texture",generator:"Texture.toJSON"},uuid:this.uuid,name:this.name,image:this.source.toJSON(t).uuid,mapping:this.mapping,channel:this.channel,repeat:[this.repeat.x,this.repeat.y],offset:[this.offset.x,this.offset.y],center:[this.center.x,this.center.y],rotation:this.rotation,wrap:[this.wrapS,this.wrapT],format:this.format,internalFormat:this.internalFormat,type:this.type,colorSpace:this.colorSpace,minFilter:this.minFilter,magFilter:this.magFilter,anisotropy:this.anisotropy,flipY:this.flipY,generateMipmaps:this.generateMipmaps,premultiplyAlpha:this.premultiplyAlpha,unpackAlignment:this.unpackAlignment};return Object.keys(this.userData).length>0&&(i.userData=this.userData),e||(t.textures[this.uuid]=i),i}dispose(){this.dispatchEvent({type:"dispose"})}transformUv(t){if(this.mapping!==_d)return t;if(t.applyMatrix3(this.matrix),t.x<0||t.x>1)switch(this.wrapS){case wl:t.x=t.x-Math.floor(t.x);break;case $i:t.x=t.x<0?0:1;break;case Rl:Math.abs(Math.floor(t.x)%2)===1?t.x=Math.ceil(t.x)-t.x:t.x=t.x-Math.floor(t.x);break}if(t.y<0||t.y>1)switch(this.wrapT){case wl:t.y=t.y-Math.floor(t.y);break;case $i:t.y=t.y<0?0:1;break;case Rl:Math.abs(Math.floor(t.y)%2)===1?t.y=Math.ceil(t.y)-t.y:t.y=t.y-Math.floor(t.y);break}return this.flipY&&(t.y=1-t.y),t}set needsUpdate(t){t===!0&&(this.version++,this.source.needsUpdate=!0)}set needsPMREMUpdate(t){t===!0&&this.pmremVersion++}}ze.DEFAULT_IMAGE=null;ze.DEFAULT_MAPPING=_d;ze.DEFAULT_ANISOTROPY=1;class ge{constructor(t=0,e=0,i=0,s=1){ge.prototype.isVector4=!0,this.x=t,this.y=e,this.z=i,this.w=s}get width(){return this.z}set width(t){this.z=t}get height(){return this.w}set height(t){this.w=t}set(t,e,i,s){return this.x=t,this.y=e,this.z=i,this.w=s,this}setScalar(t){return this.x=t,this.y=t,this.z=t,this.w=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setZ(t){return this.z=t,this}setW(t){return this.w=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;case 2:this.z=e;break;case 3:this.w=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;case 2:return this.z;case 3:return this.w;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y,this.z,this.w)}copy(t){return this.x=t.x,this.y=t.y,this.z=t.z,this.w=t.w!==void 0?t.w:1,this}add(t){return this.x+=t.x,this.y+=t.y,this.z+=t.z,this.w+=t.w,this}addScalar(t){return this.x+=t,this.y+=t,this.z+=t,this.w+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this.z=t.z+e.z,this.w=t.w+e.w,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this.z+=t.z*e,this.w+=t.w*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this.z-=t.z,this.w-=t.w,this}subScalar(t){return this.x-=t,this.y-=t,this.z-=t,this.w-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this.z=t.z-e.z,this.w=t.w-e.w,this}multiply(t){return this.x*=t.x,this.y*=t.y,this.z*=t.z,this.w*=t.w,this}multiplyScalar(t){return this.x*=t,this.y*=t,this.z*=t,this.w*=t,this}applyMatrix4(t){const e=this.x,i=this.y,s=this.z,r=this.w,o=t.elements;return this.x=o[0]*e+o[4]*i+o[8]*s+o[12]*r,this.y=o[1]*e+o[5]*i+o[9]*s+o[13]*r,this.z=o[2]*e+o[6]*i+o[10]*s+o[14]*r,this.w=o[3]*e+o[7]*i+o[11]*s+o[15]*r,this}divide(t){return this.x/=t.x,this.y/=t.y,this.z/=t.z,this.w/=t.w,this}divideScalar(t){return this.multiplyScalar(1/t)}setAxisAngleFromQuaternion(t){this.w=2*Math.acos(t.w);const e=Math.sqrt(1-t.w*t.w);return e<1e-4?(this.x=1,this.y=0,this.z=0):(this.x=t.x/e,this.y=t.y/e,this.z=t.z/e),this}setAxisAngleFromRotationMatrix(t){let e,i,s,r;const l=t.elements,u=l[0],c=l[4],h=l[8],d=l[1],p=l[5],g=l[9],v=l[2],m=l[6],f=l[10];if(Math.abs(c-d)<.01&&Math.abs(h-v)<.01&&Math.abs(g-m)<.01){if(Math.abs(c+d)<.1&&Math.abs(h+v)<.1&&Math.abs(g+m)<.1&&Math.abs(u+p+f-3)<.1)return this.set(1,0,0,0),this;e=Math.PI;const b=(u+1)/2,x=(p+1)/2,B=(f+1)/2,P=(c+d)/4,D=(h+v)/4,N=(g+m)/4;return b>x&&b>B?b<.01?(i=0,s=.707106781,r=.707106781):(i=Math.sqrt(b),s=P/i,r=D/i):x>B?x<.01?(i=.707106781,s=0,r=.707106781):(s=Math.sqrt(x),i=P/s,r=N/s):B<.01?(i=.707106781,s=.707106781,r=0):(r=Math.sqrt(B),i=D/r,s=N/r),this.set(i,s,r,e),this}let w=Math.sqrt((m-g)*(m-g)+(h-v)*(h-v)+(d-c)*(d-c));return Math.abs(w)<.001&&(w=1),this.x=(m-g)/w,this.y=(h-v)/w,this.z=(d-c)/w,this.w=Math.acos((u+p+f-1)/2),this}setFromMatrixPosition(t){const e=t.elements;return this.x=e[12],this.y=e[13],this.z=e[14],this.w=e[15],this}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this.z=Math.min(this.z,t.z),this.w=Math.min(this.w,t.w),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this.z=Math.max(this.z,t.z),this.w=Math.max(this.w,t.w),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this.z=Math.max(t.z,Math.min(e.z,this.z)),this.w=Math.max(t.w,Math.min(e.w,this.w)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this.z=Math.max(t,Math.min(e,this.z)),this.w=Math.max(t,Math.min(e,this.w)),this}clampLength(t,e){const i=this.length();return this.divideScalar(i||1).multiplyScalar(Math.max(t,Math.min(e,i)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this.w=Math.floor(this.w),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this.w=Math.ceil(this.w),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this.w=Math.round(this.w),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this.w=Math.trunc(this.w),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this.w=-this.w,this}dot(t){return this.x*t.x+this.y*t.y+this.z*t.z+this.w*t.w}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)+Math.abs(this.w)}normalize(){return this.divideScalar(this.length()||1)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this.z+=(t.z-this.z)*e,this.w+=(t.w-this.w)*e,this}lerpVectors(t,e,i){return this.x=t.x+(e.x-t.x)*i,this.y=t.y+(e.y-t.y)*i,this.z=t.z+(e.z-t.z)*i,this.w=t.w+(e.w-t.w)*i,this}equals(t){return t.x===this.x&&t.y===this.y&&t.z===this.z&&t.w===this.w}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this.z=t[e+2],this.w=t[e+3],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t[e+2]=this.z,t[e+3]=this.w,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this.z=t.getZ(e),this.w=t.getW(e),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this.w=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z,yield this.w}}class Ng extends rs{constructor(t=1,e=1,i={}){super(),this.isRenderTarget=!0,this.width=t,this.height=e,this.depth=1,this.scissor=new ge(0,0,t,e),this.scissorTest=!1,this.viewport=new ge(0,0,t,e);const s={width:t,height:e,depth:1};i=Object.assign({generateMipmaps:!1,internalFormat:null,minFilter:Nn,depthBuffer:!0,stencilBuffer:!1,resolveDepthBuffer:!0,resolveStencilBuffer:!0,depthTexture:null,samples:0,count:1},i);const r=new ze(s,i.mapping,i.wrapS,i.wrapT,i.magFilter,i.minFilter,i.format,i.type,i.anisotropy,i.colorSpace);r.flipY=!1,r.generateMipmaps=i.generateMipmaps,r.internalFormat=i.internalFormat,this.textures=[];const o=i.count;for(let a=0;a<o;a++)this.textures[a]=r.clone(),this.textures[a].isRenderTargetTexture=!0;this.depthBuffer=i.depthBuffer,this.stencilBuffer=i.stencilBuffer,this.resolveDepthBuffer=i.resolveDepthBuffer,this.resolveStencilBuffer=i.resolveStencilBuffer,this.depthTexture=i.depthTexture,this.samples=i.samples}get texture(){return this.textures[0]}set texture(t){this.textures[0]=t}setSize(t,e,i=1){if(this.width!==t||this.height!==e||this.depth!==i){this.width=t,this.height=e,this.depth=i;for(let s=0,r=this.textures.length;s<r;s++)this.textures[s].image.width=t,this.textures[s].image.height=e,this.textures[s].image.depth=i;this.dispose()}this.viewport.set(0,0,t,e),this.scissor.set(0,0,t,e)}clone(){return new this.constructor().copy(this)}copy(t){this.width=t.width,this.height=t.height,this.depth=t.depth,this.scissor.copy(t.scissor),this.scissorTest=t.scissorTest,this.viewport.copy(t.viewport),this.textures.length=0;for(let i=0,s=t.textures.length;i<s;i++)this.textures[i]=t.textures[i].clone(),this.textures[i].isRenderTargetTexture=!0;const e=Object.assign({},t.texture.image);return this.texture.source=new Cd(e),this.depthBuffer=t.depthBuffer,this.stencilBuffer=t.stencilBuffer,this.resolveDepthBuffer=t.resolveDepthBuffer,this.resolveStencilBuffer=t.resolveStencilBuffer,t.depthTexture!==null&&(this.depthTexture=t.depthTexture.clone()),this.samples=t.samples,this}dispose(){this.dispatchEvent({type:"dispose"})}}class ns extends Ng{constructor(t=1,e=1,i={}){super(t,e,i),this.isWebGLRenderTarget=!0}}class Pd extends ze{constructor(t=null,e=1,i=1,s=1){super(null),this.isDataArrayTexture=!0,this.image={data:t,width:e,height:i,depth:s},this.magFilter=Je,this.minFilter=Je,this.wrapR=$i,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1,this.layerUpdates=new Set}addLayerUpdate(t){this.layerUpdates.add(t)}clearLayerUpdates(){this.layerUpdates.clear()}}class Og extends ze{constructor(t=null,e=1,i=1,s=1){super(null),this.isData3DTexture=!0,this.image={data:t,width:e,height:i,depth:s},this.magFilter=Je,this.minFilter=Je,this.wrapR=$i,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}}class Di{constructor(t=0,e=0,i=0,s=1){this.isQuaternion=!0,this._x=t,this._y=e,this._z=i,this._w=s}static slerpFlat(t,e,i,s,r,o,a){let l=i[s+0],u=i[s+1],c=i[s+2],h=i[s+3];const d=r[o+0],p=r[o+1],g=r[o+2],v=r[o+3];if(a===0){t[e+0]=l,t[e+1]=u,t[e+2]=c,t[e+3]=h;return}if(a===1){t[e+0]=d,t[e+1]=p,t[e+2]=g,t[e+3]=v;return}if(h!==v||l!==d||u!==p||c!==g){let m=1-a;const f=l*d+u*p+c*g+h*v,w=f>=0?1:-1,b=1-f*f;if(b>Number.EPSILON){const B=Math.sqrt(b),P=Math.atan2(B,f*w);m=Math.sin(m*P)/B,a=Math.sin(a*P)/B}const x=a*w;if(l=l*m+d*x,u=u*m+p*x,c=c*m+g*x,h=h*m+v*x,m===1-a){const B=1/Math.sqrt(l*l+u*u+c*c+h*h);l*=B,u*=B,c*=B,h*=B}}t[e]=l,t[e+1]=u,t[e+2]=c,t[e+3]=h}static multiplyQuaternionsFlat(t,e,i,s,r,o){const a=i[s],l=i[s+1],u=i[s+2],c=i[s+3],h=r[o],d=r[o+1],p=r[o+2],g=r[o+3];return t[e]=a*g+c*h+l*p-u*d,t[e+1]=l*g+c*d+u*h-a*p,t[e+2]=u*g+c*p+a*d-l*h,t[e+3]=c*g-a*h-l*d-u*p,t}get x(){return this._x}set x(t){this._x=t,this._onChangeCallback()}get y(){return this._y}set y(t){this._y=t,this._onChangeCallback()}get z(){return this._z}set z(t){this._z=t,this._onChangeCallback()}get w(){return this._w}set w(t){this._w=t,this._onChangeCallback()}set(t,e,i,s){return this._x=t,this._y=e,this._z=i,this._w=s,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._w)}copy(t){return this._x=t.x,this._y=t.y,this._z=t.z,this._w=t.w,this._onChangeCallback(),this}setFromEuler(t,e=!0){const i=t._x,s=t._y,r=t._z,o=t._order,a=Math.cos,l=Math.sin,u=a(i/2),c=a(s/2),h=a(r/2),d=l(i/2),p=l(s/2),g=l(r/2);switch(o){case"XYZ":this._x=d*c*h+u*p*g,this._y=u*p*h-d*c*g,this._z=u*c*g+d*p*h,this._w=u*c*h-d*p*g;break;case"YXZ":this._x=d*c*h+u*p*g,this._y=u*p*h-d*c*g,this._z=u*c*g-d*p*h,this._w=u*c*h+d*p*g;break;case"ZXY":this._x=d*c*h-u*p*g,this._y=u*p*h+d*c*g,this._z=u*c*g+d*p*h,this._w=u*c*h-d*p*g;break;case"ZYX":this._x=d*c*h-u*p*g,this._y=u*p*h+d*c*g,this._z=u*c*g-d*p*h,this._w=u*c*h+d*p*g;break;case"YZX":this._x=d*c*h+u*p*g,this._y=u*p*h+d*c*g,this._z=u*c*g-d*p*h,this._w=u*c*h-d*p*g;break;case"XZY":this._x=d*c*h-u*p*g,this._y=u*p*h-d*c*g,this._z=u*c*g+d*p*h,this._w=u*c*h+d*p*g;break;default:console.warn("THREE.Quaternion: .setFromEuler() encountered an unknown order: "+o)}return e===!0&&this._onChangeCallback(),this}setFromAxisAngle(t,e){const i=e/2,s=Math.sin(i);return this._x=t.x*s,this._y=t.y*s,this._z=t.z*s,this._w=Math.cos(i),this._onChangeCallback(),this}setFromRotationMatrix(t){const e=t.elements,i=e[0],s=e[4],r=e[8],o=e[1],a=e[5],l=e[9],u=e[2],c=e[6],h=e[10],d=i+a+h;if(d>0){const p=.5/Math.sqrt(d+1);this._w=.25/p,this._x=(c-l)*p,this._y=(r-u)*p,this._z=(o-s)*p}else if(i>a&&i>h){const p=2*Math.sqrt(1+i-a-h);this._w=(c-l)/p,this._x=.25*p,this._y=(s+o)/p,this._z=(r+u)/p}else if(a>h){const p=2*Math.sqrt(1+a-i-h);this._w=(r-u)/p,this._x=(s+o)/p,this._y=.25*p,this._z=(l+c)/p}else{const p=2*Math.sqrt(1+h-i-a);this._w=(o-s)/p,this._x=(r+u)/p,this._y=(l+c)/p,this._z=.25*p}return this._onChangeCallback(),this}setFromUnitVectors(t,e){let i=t.dot(e)+1;return i<Number.EPSILON?(i=0,Math.abs(t.x)>Math.abs(t.z)?(this._x=-t.y,this._y=t.x,this._z=0,this._w=i):(this._x=0,this._y=-t.z,this._z=t.y,this._w=i)):(this._x=t.y*e.z-t.z*e.y,this._y=t.z*e.x-t.x*e.z,this._z=t.x*e.y-t.y*e.x,this._w=i),this.normalize()}angleTo(t){return 2*Math.acos(Math.abs(Fe(this.dot(t),-1,1)))}rotateTowards(t,e){const i=this.angleTo(t);if(i===0)return this;const s=Math.min(1,e/i);return this.slerp(t,s),this}identity(){return this.set(0,0,0,1)}invert(){return this.conjugate()}conjugate(){return this._x*=-1,this._y*=-1,this._z*=-1,this._onChangeCallback(),this}dot(t){return this._x*t._x+this._y*t._y+this._z*t._z+this._w*t._w}lengthSq(){return this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w}length(){return Math.sqrt(this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w)}normalize(){let t=this.length();return t===0?(this._x=0,this._y=0,this._z=0,this._w=1):(t=1/t,this._x=this._x*t,this._y=this._y*t,this._z=this._z*t,this._w=this._w*t),this._onChangeCallback(),this}multiply(t){return this.multiplyQuaternions(this,t)}premultiply(t){return this.multiplyQuaternions(t,this)}multiplyQuaternions(t,e){const i=t._x,s=t._y,r=t._z,o=t._w,a=e._x,l=e._y,u=e._z,c=e._w;return this._x=i*c+o*a+s*u-r*l,this._y=s*c+o*l+r*a-i*u,this._z=r*c+o*u+i*l-s*a,this._w=o*c-i*a-s*l-r*u,this._onChangeCallback(),this}slerp(t,e){if(e===0)return this;if(e===1)return this.copy(t);const i=this._x,s=this._y,r=this._z,o=this._w;let a=o*t._w+i*t._x+s*t._y+r*t._z;if(a<0?(this._w=-t._w,this._x=-t._x,this._y=-t._y,this._z=-t._z,a=-a):this.copy(t),a>=1)return this._w=o,this._x=i,this._y=s,this._z=r,this;const l=1-a*a;if(l<=Number.EPSILON){const p=1-e;return this._w=p*o+e*this._w,this._x=p*i+e*this._x,this._y=p*s+e*this._y,this._z=p*r+e*this._z,this.normalize(),this}const u=Math.sqrt(l),c=Math.atan2(u,a),h=Math.sin((1-e)*c)/u,d=Math.sin(e*c)/u;return this._w=o*h+this._w*d,this._x=i*h+this._x*d,this._y=s*h+this._y*d,this._z=r*h+this._z*d,this._onChangeCallback(),this}slerpQuaternions(t,e,i){return this.copy(t).slerp(e,i)}random(){const t=2*Math.PI*Math.random(),e=2*Math.PI*Math.random(),i=Math.random(),s=Math.sqrt(1-i),r=Math.sqrt(i);return this.set(s*Math.sin(t),s*Math.cos(t),r*Math.sin(e),r*Math.cos(e))}equals(t){return t._x===this._x&&t._y===this._y&&t._z===this._z&&t._w===this._w}fromArray(t,e=0){return this._x=t[e],this._y=t[e+1],this._z=t[e+2],this._w=t[e+3],this._onChangeCallback(),this}toArray(t=[],e=0){return t[e]=this._x,t[e+1]=this._y,t[e+2]=this._z,t[e+3]=this._w,t}fromBufferAttribute(t,e){return this._x=t.getX(e),this._y=t.getY(e),this._z=t.getZ(e),this._w=t.getW(e),this._onChangeCallback(),this}toJSON(){return this.toArray()}_onChange(t){return this._onChangeCallback=t,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._w}}class G{constructor(t=0,e=0,i=0){G.prototype.isVector3=!0,this.x=t,this.y=e,this.z=i}set(t,e,i){return i===void 0&&(i=this.z),this.x=t,this.y=e,this.z=i,this}setScalar(t){return this.x=t,this.y=t,this.z=t,this}setX(t){return this.x=t,this}setY(t){return this.y=t,this}setZ(t){return this.z=t,this}setComponent(t,e){switch(t){case 0:this.x=e;break;case 1:this.y=e;break;case 2:this.z=e;break;default:throw new Error("index is out of range: "+t)}return this}getComponent(t){switch(t){case 0:return this.x;case 1:return this.y;case 2:return this.z;default:throw new Error("index is out of range: "+t)}}clone(){return new this.constructor(this.x,this.y,this.z)}copy(t){return this.x=t.x,this.y=t.y,this.z=t.z,this}add(t){return this.x+=t.x,this.y+=t.y,this.z+=t.z,this}addScalar(t){return this.x+=t,this.y+=t,this.z+=t,this}addVectors(t,e){return this.x=t.x+e.x,this.y=t.y+e.y,this.z=t.z+e.z,this}addScaledVector(t,e){return this.x+=t.x*e,this.y+=t.y*e,this.z+=t.z*e,this}sub(t){return this.x-=t.x,this.y-=t.y,this.z-=t.z,this}subScalar(t){return this.x-=t,this.y-=t,this.z-=t,this}subVectors(t,e){return this.x=t.x-e.x,this.y=t.y-e.y,this.z=t.z-e.z,this}multiply(t){return this.x*=t.x,this.y*=t.y,this.z*=t.z,this}multiplyScalar(t){return this.x*=t,this.y*=t,this.z*=t,this}multiplyVectors(t,e){return this.x=t.x*e.x,this.y=t.y*e.y,this.z=t.z*e.z,this}applyEuler(t){return this.applyQuaternion(Zu.setFromEuler(t))}applyAxisAngle(t,e){return this.applyQuaternion(Zu.setFromAxisAngle(t,e))}applyMatrix3(t){const e=this.x,i=this.y,s=this.z,r=t.elements;return this.x=r[0]*e+r[3]*i+r[6]*s,this.y=r[1]*e+r[4]*i+r[7]*s,this.z=r[2]*e+r[5]*i+r[8]*s,this}applyNormalMatrix(t){return this.applyMatrix3(t).normalize()}applyMatrix4(t){const e=this.x,i=this.y,s=this.z,r=t.elements,o=1/(r[3]*e+r[7]*i+r[11]*s+r[15]);return this.x=(r[0]*e+r[4]*i+r[8]*s+r[12])*o,this.y=(r[1]*e+r[5]*i+r[9]*s+r[13])*o,this.z=(r[2]*e+r[6]*i+r[10]*s+r[14])*o,this}applyQuaternion(t){const e=this.x,i=this.y,s=this.z,r=t.x,o=t.y,a=t.z,l=t.w,u=2*(o*s-a*i),c=2*(a*e-r*s),h=2*(r*i-o*e);return this.x=e+l*u+o*h-a*c,this.y=i+l*c+a*u-r*h,this.z=s+l*h+r*c-o*u,this}project(t){return this.applyMatrix4(t.matrixWorldInverse).applyMatrix4(t.projectionMatrix)}unproject(t){return this.applyMatrix4(t.projectionMatrixInverse).applyMatrix4(t.matrixWorld)}transformDirection(t){const e=this.x,i=this.y,s=this.z,r=t.elements;return this.x=r[0]*e+r[4]*i+r[8]*s,this.y=r[1]*e+r[5]*i+r[9]*s,this.z=r[2]*e+r[6]*i+r[10]*s,this.normalize()}divide(t){return this.x/=t.x,this.y/=t.y,this.z/=t.z,this}divideScalar(t){return this.multiplyScalar(1/t)}min(t){return this.x=Math.min(this.x,t.x),this.y=Math.min(this.y,t.y),this.z=Math.min(this.z,t.z),this}max(t){return this.x=Math.max(this.x,t.x),this.y=Math.max(this.y,t.y),this.z=Math.max(this.z,t.z),this}clamp(t,e){return this.x=Math.max(t.x,Math.min(e.x,this.x)),this.y=Math.max(t.y,Math.min(e.y,this.y)),this.z=Math.max(t.z,Math.min(e.z,this.z)),this}clampScalar(t,e){return this.x=Math.max(t,Math.min(e,this.x)),this.y=Math.max(t,Math.min(e,this.y)),this.z=Math.max(t,Math.min(e,this.z)),this}clampLength(t,e){const i=this.length();return this.divideScalar(i||1).multiplyScalar(Math.max(t,Math.min(e,i)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this}dot(t){return this.x*t.x+this.y*t.y+this.z*t.z}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)}normalize(){return this.divideScalar(this.length()||1)}setLength(t){return this.normalize().multiplyScalar(t)}lerp(t,e){return this.x+=(t.x-this.x)*e,this.y+=(t.y-this.y)*e,this.z+=(t.z-this.z)*e,this}lerpVectors(t,e,i){return this.x=t.x+(e.x-t.x)*i,this.y=t.y+(e.y-t.y)*i,this.z=t.z+(e.z-t.z)*i,this}cross(t){return this.crossVectors(this,t)}crossVectors(t,e){const i=t.x,s=t.y,r=t.z,o=e.x,a=e.y,l=e.z;return this.x=s*l-r*a,this.y=r*o-i*l,this.z=i*a-s*o,this}projectOnVector(t){const e=t.lengthSq();if(e===0)return this.set(0,0,0);const i=t.dot(this)/e;return this.copy(t).multiplyScalar(i)}projectOnPlane(t){return wa.copy(this).projectOnVector(t),this.sub(wa)}reflect(t){return this.sub(wa.copy(t).multiplyScalar(2*this.dot(t)))}angleTo(t){const e=Math.sqrt(this.lengthSq()*t.lengthSq());if(e===0)return Math.PI/2;const i=this.dot(t)/e;return Math.acos(Fe(i,-1,1))}distanceTo(t){return Math.sqrt(this.distanceToSquared(t))}distanceToSquared(t){const e=this.x-t.x,i=this.y-t.y,s=this.z-t.z;return e*e+i*i+s*s}manhattanDistanceTo(t){return Math.abs(this.x-t.x)+Math.abs(this.y-t.y)+Math.abs(this.z-t.z)}setFromSpherical(t){return this.setFromSphericalCoords(t.radius,t.phi,t.theta)}setFromSphericalCoords(t,e,i){const s=Math.sin(e)*t;return this.x=s*Math.sin(i),this.y=Math.cos(e)*t,this.z=s*Math.cos(i),this}setFromCylindrical(t){return this.setFromCylindricalCoords(t.radius,t.theta,t.y)}setFromCylindricalCoords(t,e,i){return this.x=t*Math.sin(e),this.y=i,this.z=t*Math.cos(e),this}setFromMatrixPosition(t){const e=t.elements;return this.x=e[12],this.y=e[13],this.z=e[14],this}setFromMatrixScale(t){const e=this.setFromMatrixColumn(t,0).length(),i=this.setFromMatrixColumn(t,1).length(),s=this.setFromMatrixColumn(t,2).length();return this.x=e,this.y=i,this.z=s,this}setFromMatrixColumn(t,e){return this.fromArray(t.elements,e*4)}setFromMatrix3Column(t,e){return this.fromArray(t.elements,e*3)}setFromEuler(t){return this.x=t._x,this.y=t._y,this.z=t._z,this}setFromColor(t){return this.x=t.r,this.y=t.g,this.z=t.b,this}equals(t){return t.x===this.x&&t.y===this.y&&t.z===this.z}fromArray(t,e=0){return this.x=t[e],this.y=t[e+1],this.z=t[e+2],this}toArray(t=[],e=0){return t[e]=this.x,t[e+1]=this.y,t[e+2]=this.z,t}fromBufferAttribute(t,e){return this.x=t.getX(e),this.y=t.getY(e),this.z=t.getZ(e),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this}randomDirection(){const t=Math.random()*Math.PI*2,e=Math.random()*2-1,i=Math.sqrt(1-e*e);return this.x=i*Math.cos(t),this.y=e,this.z=i*Math.sin(t),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z}}const wa=new G,Zu=new Di;class os{constructor(t=new G(1/0,1/0,1/0),e=new G(-1/0,-1/0,-1/0)){this.isBox3=!0,this.min=t,this.max=e}set(t,e){return this.min.copy(t),this.max.copy(e),this}setFromArray(t){this.makeEmpty();for(let e=0,i=t.length;e<i;e+=3)this.expandByPoint(dn.fromArray(t,e));return this}setFromBufferAttribute(t){this.makeEmpty();for(let e=0,i=t.count;e<i;e++)this.expandByPoint(dn.fromBufferAttribute(t,e));return this}setFromPoints(t){this.makeEmpty();for(let e=0,i=t.length;e<i;e++)this.expandByPoint(t[e]);return this}setFromCenterAndSize(t,e){const i=dn.copy(e).multiplyScalar(.5);return this.min.copy(t).sub(i),this.max.copy(t).add(i),this}setFromObject(t,e=!1){return this.makeEmpty(),this.expandByObject(t,e)}clone(){return new this.constructor().copy(this)}copy(t){return this.min.copy(t.min),this.max.copy(t.max),this}makeEmpty(){return this.min.x=this.min.y=this.min.z=1/0,this.max.x=this.max.y=this.max.z=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y||this.max.z<this.min.z}getCenter(t){return this.isEmpty()?t.set(0,0,0):t.addVectors(this.min,this.max).multiplyScalar(.5)}getSize(t){return this.isEmpty()?t.set(0,0,0):t.subVectors(this.max,this.min)}expandByPoint(t){return this.min.min(t),this.max.max(t),this}expandByVector(t){return this.min.sub(t),this.max.add(t),this}expandByScalar(t){return this.min.addScalar(-t),this.max.addScalar(t),this}expandByObject(t,e=!1){t.updateWorldMatrix(!1,!1);const i=t.geometry;if(i!==void 0){const r=i.getAttribute("position");if(e===!0&&r!==void 0&&t.isInstancedMesh!==!0)for(let o=0,a=r.count;o<a;o++)t.isMesh===!0?t.getVertexPosition(o,dn):dn.fromBufferAttribute(r,o),dn.applyMatrix4(t.matrixWorld),this.expandByPoint(dn);else t.boundingBox!==void 0?(t.boundingBox===null&&t.computeBoundingBox(),Vr.copy(t.boundingBox)):(i.boundingBox===null&&i.computeBoundingBox(),Vr.copy(i.boundingBox)),Vr.applyMatrix4(t.matrixWorld),this.union(Vr)}const s=t.children;for(let r=0,o=s.length;r<o;r++)this.expandByObject(s[r],e);return this}containsPoint(t){return t.x>=this.min.x&&t.x<=this.max.x&&t.y>=this.min.y&&t.y<=this.max.y&&t.z>=this.min.z&&t.z<=this.max.z}containsBox(t){return this.min.x<=t.min.x&&t.max.x<=this.max.x&&this.min.y<=t.min.y&&t.max.y<=this.max.y&&this.min.z<=t.min.z&&t.max.z<=this.max.z}getParameter(t,e){return e.set((t.x-this.min.x)/(this.max.x-this.min.x),(t.y-this.min.y)/(this.max.y-this.min.y),(t.z-this.min.z)/(this.max.z-this.min.z))}intersectsBox(t){return t.max.x>=this.min.x&&t.min.x<=this.max.x&&t.max.y>=this.min.y&&t.min.y<=this.max.y&&t.max.z>=this.min.z&&t.min.z<=this.max.z}intersectsSphere(t){return this.clampPoint(t.center,dn),dn.distanceToSquared(t.center)<=t.radius*t.radius}intersectsPlane(t){let e,i;return t.normal.x>0?(e=t.normal.x*this.min.x,i=t.normal.x*this.max.x):(e=t.normal.x*this.max.x,i=t.normal.x*this.min.x),t.normal.y>0?(e+=t.normal.y*this.min.y,i+=t.normal.y*this.max.y):(e+=t.normal.y*this.max.y,i+=t.normal.y*this.min.y),t.normal.z>0?(e+=t.normal.z*this.min.z,i+=t.normal.z*this.max.z):(e+=t.normal.z*this.max.z,i+=t.normal.z*this.min.z),e<=-t.constant&&i>=-t.constant}intersectsTriangle(t){if(this.isEmpty())return!1;this.getCenter(Ks),Gr.subVectors(this.max,Ks),hs.subVectors(t.a,Ks),fs.subVectors(t.b,Ks),ds.subVectors(t.c,Ks),pi.subVectors(fs,hs),mi.subVectors(ds,fs),Fi.subVectors(hs,ds);let e=[0,-pi.z,pi.y,0,-mi.z,mi.y,0,-Fi.z,Fi.y,pi.z,0,-pi.x,mi.z,0,-mi.x,Fi.z,0,-Fi.x,-pi.y,pi.x,0,-mi.y,mi.x,0,-Fi.y,Fi.x,0];return!Ra(e,hs,fs,ds,Gr)||(e=[1,0,0,0,1,0,0,0,1],!Ra(e,hs,fs,ds,Gr))?!1:(Wr.crossVectors(pi,mi),e=[Wr.x,Wr.y,Wr.z],Ra(e,hs,fs,ds,Gr))}clampPoint(t,e){return e.copy(t).clamp(this.min,this.max)}distanceToPoint(t){return this.clampPoint(t,dn).distanceTo(t)}getBoundingSphere(t){return this.isEmpty()?t.makeEmpty():(this.getCenter(t.center),t.radius=this.getSize(dn).length()*.5),t}intersect(t){return this.min.max(t.min),this.max.min(t.max),this.isEmpty()&&this.makeEmpty(),this}union(t){return this.min.min(t.min),this.max.max(t.max),this}applyMatrix4(t){return this.isEmpty()?this:($n[0].set(this.min.x,this.min.y,this.min.z).applyMatrix4(t),$n[1].set(this.min.x,this.min.y,this.max.z).applyMatrix4(t),$n[2].set(this.min.x,this.max.y,this.min.z).applyMatrix4(t),$n[3].set(this.min.x,this.max.y,this.max.z).applyMatrix4(t),$n[4].set(this.max.x,this.min.y,this.min.z).applyMatrix4(t),$n[5].set(this.max.x,this.min.y,this.max.z).applyMatrix4(t),$n[6].set(this.max.x,this.max.y,this.min.z).applyMatrix4(t),$n[7].set(this.max.x,this.max.y,this.max.z).applyMatrix4(t),this.setFromPoints($n),this)}translate(t){return this.min.add(t),this.max.add(t),this}equals(t){return t.min.equals(this.min)&&t.max.equals(this.max)}}const $n=[new G,new G,new G,new G,new G,new G,new G,new G],dn=new G,Vr=new os,hs=new G,fs=new G,ds=new G,pi=new G,mi=new G,Fi=new G,Ks=new G,Gr=new G,Wr=new G,Bi=new G;function Ra(n,t,e,i,s){for(let r=0,o=n.length-3;r<=o;r+=3){Bi.fromArray(n,r);const a=s.x*Math.abs(Bi.x)+s.y*Math.abs(Bi.y)+s.z*Math.abs(Bi.z),l=t.dot(Bi),u=e.dot(Bi),c=i.dot(Bi);if(Math.max(-Math.max(l,u,c),Math.min(l,u,c))>a)return!1}return!0}const Fg=new os,$s=new G,Ca=new G;class Dr{constructor(t=new G,e=-1){this.isSphere=!0,this.center=t,this.radius=e}set(t,e){return this.center.copy(t),this.radius=e,this}setFromPoints(t,e){const i=this.center;e!==void 0?i.copy(e):Fg.setFromPoints(t).getCenter(i);let s=0;for(let r=0,o=t.length;r<o;r++)s=Math.max(s,i.distanceToSquared(t[r]));return this.radius=Math.sqrt(s),this}copy(t){return this.center.copy(t.center),this.radius=t.radius,this}isEmpty(){return this.radius<0}makeEmpty(){return this.center.set(0,0,0),this.radius=-1,this}containsPoint(t){return t.distanceToSquared(this.center)<=this.radius*this.radius}distanceToPoint(t){return t.distanceTo(this.center)-this.radius}intersectsSphere(t){const e=this.radius+t.radius;return t.center.distanceToSquared(this.center)<=e*e}intersectsBox(t){return t.intersectsSphere(this)}intersectsPlane(t){return Math.abs(t.distanceToPoint(this.center))<=this.radius}clampPoint(t,e){const i=this.center.distanceToSquared(t);return e.copy(t),i>this.radius*this.radius&&(e.sub(this.center).normalize(),e.multiplyScalar(this.radius).add(this.center)),e}getBoundingBox(t){return this.isEmpty()?(t.makeEmpty(),t):(t.set(this.center,this.center),t.expandByScalar(this.radius),t)}applyMatrix4(t){return this.center.applyMatrix4(t),this.radius=this.radius*t.getMaxScaleOnAxis(),this}translate(t){return this.center.add(t),this}expandByPoint(t){if(this.isEmpty())return this.center.copy(t),this.radius=0,this;$s.subVectors(t,this.center);const e=$s.lengthSq();if(e>this.radius*this.radius){const i=Math.sqrt(e),s=(i-this.radius)*.5;this.center.addScaledVector($s,s/i),this.radius+=s}return this}union(t){return t.isEmpty()?this:this.isEmpty()?(this.copy(t),this):(this.center.equals(t.center)===!0?this.radius=Math.max(this.radius,t.radius):(Ca.subVectors(t.center,this.center).setLength(t.radius),this.expandByPoint($s.copy(t.center).add(Ca)),this.expandByPoint($s.copy(t.center).sub(Ca))),this)}equals(t){return t.center.equals(this.center)&&t.radius===this.radius}clone(){return new this.constructor().copy(this)}}const Zn=new G,Pa=new G,Xr=new G,_i=new G,Da=new G,qr=new G,La=new G;class Dd{constructor(t=new G,e=new G(0,0,-1)){this.origin=t,this.direction=e}set(t,e){return this.origin.copy(t),this.direction.copy(e),this}copy(t){return this.origin.copy(t.origin),this.direction.copy(t.direction),this}at(t,e){return e.copy(this.origin).addScaledVector(this.direction,t)}lookAt(t){return this.direction.copy(t).sub(this.origin).normalize(),this}recast(t){return this.origin.copy(this.at(t,Zn)),this}closestPointToPoint(t,e){e.subVectors(t,this.origin);const i=e.dot(this.direction);return i<0?e.copy(this.origin):e.copy(this.origin).addScaledVector(this.direction,i)}distanceToPoint(t){return Math.sqrt(this.distanceSqToPoint(t))}distanceSqToPoint(t){const e=Zn.subVectors(t,this.origin).dot(this.direction);return e<0?this.origin.distanceToSquared(t):(Zn.copy(this.origin).addScaledVector(this.direction,e),Zn.distanceToSquared(t))}distanceSqToSegment(t,e,i,s){Pa.copy(t).add(e).multiplyScalar(.5),Xr.copy(e).sub(t).normalize(),_i.copy(this.origin).sub(Pa);const r=t.distanceTo(e)*.5,o=-this.direction.dot(Xr),a=_i.dot(this.direction),l=-_i.dot(Xr),u=_i.lengthSq(),c=Math.abs(1-o*o);let h,d,p,g;if(c>0)if(h=o*l-a,d=o*a-l,g=r*c,h>=0)if(d>=-g)if(d<=g){const v=1/c;h*=v,d*=v,p=h*(h+o*d+2*a)+d*(o*h+d+2*l)+u}else d=r,h=Math.max(0,-(o*d+a)),p=-h*h+d*(d+2*l)+u;else d=-r,h=Math.max(0,-(o*d+a)),p=-h*h+d*(d+2*l)+u;else d<=-g?(h=Math.max(0,-(-o*r+a)),d=h>0?-r:Math.min(Math.max(-r,-l),r),p=-h*h+d*(d+2*l)+u):d<=g?(h=0,d=Math.min(Math.max(-r,-l),r),p=d*(d+2*l)+u):(h=Math.max(0,-(o*r+a)),d=h>0?r:Math.min(Math.max(-r,-l),r),p=-h*h+d*(d+2*l)+u);else d=o>0?-r:r,h=Math.max(0,-(o*d+a)),p=-h*h+d*(d+2*l)+u;return i&&i.copy(this.origin).addScaledVector(this.direction,h),s&&s.copy(Pa).addScaledVector(Xr,d),p}intersectSphere(t,e){Zn.subVectors(t.center,this.origin);const i=Zn.dot(this.direction),s=Zn.dot(Zn)-i*i,r=t.radius*t.radius;if(s>r)return null;const o=Math.sqrt(r-s),a=i-o,l=i+o;return l<0?null:a<0?this.at(l,e):this.at(a,e)}intersectsSphere(t){return this.distanceSqToPoint(t.center)<=t.radius*t.radius}distanceToPlane(t){const e=t.normal.dot(this.direction);if(e===0)return t.distanceToPoint(this.origin)===0?0:null;const i=-(this.origin.dot(t.normal)+t.constant)/e;return i>=0?i:null}intersectPlane(t,e){const i=this.distanceToPlane(t);return i===null?null:this.at(i,e)}intersectsPlane(t){const e=t.distanceToPoint(this.origin);return e===0||t.normal.dot(this.direction)*e<0}intersectBox(t,e){let i,s,r,o,a,l;const u=1/this.direction.x,c=1/this.direction.y,h=1/this.direction.z,d=this.origin;return u>=0?(i=(t.min.x-d.x)*u,s=(t.max.x-d.x)*u):(i=(t.max.x-d.x)*u,s=(t.min.x-d.x)*u),c>=0?(r=(t.min.y-d.y)*c,o=(t.max.y-d.y)*c):(r=(t.max.y-d.y)*c,o=(t.min.y-d.y)*c),i>o||r>s||((r>i||isNaN(i))&&(i=r),(o<s||isNaN(s))&&(s=o),h>=0?(a=(t.min.z-d.z)*h,l=(t.max.z-d.z)*h):(a=(t.max.z-d.z)*h,l=(t.min.z-d.z)*h),i>l||a>s)||((a>i||i!==i)&&(i=a),(l<s||s!==s)&&(s=l),s<0)?null:this.at(i>=0?i:s,e)}intersectsBox(t){return this.intersectBox(t,Zn)!==null}intersectTriangle(t,e,i,s,r){Da.subVectors(e,t),qr.subVectors(i,t),La.crossVectors(Da,qr);let o=this.direction.dot(La),a;if(o>0){if(s)return null;a=1}else if(o<0)a=-1,o=-o;else return null;_i.subVectors(this.origin,t);const l=a*this.direction.dot(qr.crossVectors(_i,qr));if(l<0)return null;const u=a*this.direction.dot(Da.cross(_i));if(u<0||l+u>o)return null;const c=-a*_i.dot(La);return c<0?null:this.at(c/o,r)}applyMatrix4(t){return this.origin.applyMatrix4(t),this.direction.transformDirection(t),this}equals(t){return t.origin.equals(this.origin)&&t.direction.equals(this.direction)}clone(){return new this.constructor().copy(this)}}class ue{constructor(t,e,i,s,r,o,a,l,u,c,h,d,p,g,v,m){ue.prototype.isMatrix4=!0,this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],t!==void 0&&this.set(t,e,i,s,r,o,a,l,u,c,h,d,p,g,v,m)}set(t,e,i,s,r,o,a,l,u,c,h,d,p,g,v,m){const f=this.elements;return f[0]=t,f[4]=e,f[8]=i,f[12]=s,f[1]=r,f[5]=o,f[9]=a,f[13]=l,f[2]=u,f[6]=c,f[10]=h,f[14]=d,f[3]=p,f[7]=g,f[11]=v,f[15]=m,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),this}clone(){return new ue().fromArray(this.elements)}copy(t){const e=this.elements,i=t.elements;return e[0]=i[0],e[1]=i[1],e[2]=i[2],e[3]=i[3],e[4]=i[4],e[5]=i[5],e[6]=i[6],e[7]=i[7],e[8]=i[8],e[9]=i[9],e[10]=i[10],e[11]=i[11],e[12]=i[12],e[13]=i[13],e[14]=i[14],e[15]=i[15],this}copyPosition(t){const e=this.elements,i=t.elements;return e[12]=i[12],e[13]=i[13],e[14]=i[14],this}setFromMatrix3(t){const e=t.elements;return this.set(e[0],e[3],e[6],0,e[1],e[4],e[7],0,e[2],e[5],e[8],0,0,0,0,1),this}extractBasis(t,e,i){return t.setFromMatrixColumn(this,0),e.setFromMatrixColumn(this,1),i.setFromMatrixColumn(this,2),this}makeBasis(t,e,i){return this.set(t.x,e.x,i.x,0,t.y,e.y,i.y,0,t.z,e.z,i.z,0,0,0,0,1),this}extractRotation(t){const e=this.elements,i=t.elements,s=1/ps.setFromMatrixColumn(t,0).length(),r=1/ps.setFromMatrixColumn(t,1).length(),o=1/ps.setFromMatrixColumn(t,2).length();return e[0]=i[0]*s,e[1]=i[1]*s,e[2]=i[2]*s,e[3]=0,e[4]=i[4]*r,e[5]=i[5]*r,e[6]=i[6]*r,e[7]=0,e[8]=i[8]*o,e[9]=i[9]*o,e[10]=i[10]*o,e[11]=0,e[12]=0,e[13]=0,e[14]=0,e[15]=1,this}makeRotationFromEuler(t){const e=this.elements,i=t.x,s=t.y,r=t.z,o=Math.cos(i),a=Math.sin(i),l=Math.cos(s),u=Math.sin(s),c=Math.cos(r),h=Math.sin(r);if(t.order==="XYZ"){const d=o*c,p=o*h,g=a*c,v=a*h;e[0]=l*c,e[4]=-l*h,e[8]=u,e[1]=p+g*u,e[5]=d-v*u,e[9]=-a*l,e[2]=v-d*u,e[6]=g+p*u,e[10]=o*l}else if(t.order==="YXZ"){const d=l*c,p=l*h,g=u*c,v=u*h;e[0]=d+v*a,e[4]=g*a-p,e[8]=o*u,e[1]=o*h,e[5]=o*c,e[9]=-a,e[2]=p*a-g,e[6]=v+d*a,e[10]=o*l}else if(t.order==="ZXY"){const d=l*c,p=l*h,g=u*c,v=u*h;e[0]=d-v*a,e[4]=-o*h,e[8]=g+p*a,e[1]=p+g*a,e[5]=o*c,e[9]=v-d*a,e[2]=-o*u,e[6]=a,e[10]=o*l}else if(t.order==="ZYX"){const d=o*c,p=o*h,g=a*c,v=a*h;e[0]=l*c,e[4]=g*u-p,e[8]=d*u+v,e[1]=l*h,e[5]=v*u+d,e[9]=p*u-g,e[2]=-u,e[6]=a*l,e[10]=o*l}else if(t.order==="YZX"){const d=o*l,p=o*u,g=a*l,v=a*u;e[0]=l*c,e[4]=v-d*h,e[8]=g*h+p,e[1]=h,e[5]=o*c,e[9]=-a*c,e[2]=-u*c,e[6]=p*h+g,e[10]=d-v*h}else if(t.order==="XZY"){const d=o*l,p=o*u,g=a*l,v=a*u;e[0]=l*c,e[4]=-h,e[8]=u*c,e[1]=d*h+v,e[5]=o*c,e[9]=p*h-g,e[2]=g*h-p,e[6]=a*c,e[10]=v*h+d}return e[3]=0,e[7]=0,e[11]=0,e[12]=0,e[13]=0,e[14]=0,e[15]=1,this}makeRotationFromQuaternion(t){return this.compose(Bg,t,zg)}lookAt(t,e,i){const s=this.elements;return Ke.subVectors(t,e),Ke.lengthSq()===0&&(Ke.z=1),Ke.normalize(),gi.crossVectors(i,Ke),gi.lengthSq()===0&&(Math.abs(i.z)===1?Ke.x+=1e-4:Ke.z+=1e-4,Ke.normalize(),gi.crossVectors(i,Ke)),gi.normalize(),Yr.crossVectors(Ke,gi),s[0]=gi.x,s[4]=Yr.x,s[8]=Ke.x,s[1]=gi.y,s[5]=Yr.y,s[9]=Ke.y,s[2]=gi.z,s[6]=Yr.z,s[10]=Ke.z,this}multiply(t){return this.multiplyMatrices(this,t)}premultiply(t){return this.multiplyMatrices(t,this)}multiplyMatrices(t,e){const i=t.elements,s=e.elements,r=this.elements,o=i[0],a=i[4],l=i[8],u=i[12],c=i[1],h=i[5],d=i[9],p=i[13],g=i[2],v=i[6],m=i[10],f=i[14],w=i[3],b=i[7],x=i[11],B=i[15],P=s[0],D=s[4],N=s[8],E=s[12],M=s[1],L=s[5],J=s[9],C=s[13],k=s[2],Y=s[6],H=s[10],q=s[14],z=s[3],at=s[7],dt=s[11],bt=s[15];return r[0]=o*P+a*M+l*k+u*z,r[4]=o*D+a*L+l*Y+u*at,r[8]=o*N+a*J+l*H+u*dt,r[12]=o*E+a*C+l*q+u*bt,r[1]=c*P+h*M+d*k+p*z,r[5]=c*D+h*L+d*Y+p*at,r[9]=c*N+h*J+d*H+p*dt,r[13]=c*E+h*C+d*q+p*bt,r[2]=g*P+v*M+m*k+f*z,r[6]=g*D+v*L+m*Y+f*at,r[10]=g*N+v*J+m*H+f*dt,r[14]=g*E+v*C+m*q+f*bt,r[3]=w*P+b*M+x*k+B*z,r[7]=w*D+b*L+x*Y+B*at,r[11]=w*N+b*J+x*H+B*dt,r[15]=w*E+b*C+x*q+B*bt,this}multiplyScalar(t){const e=this.elements;return e[0]*=t,e[4]*=t,e[8]*=t,e[12]*=t,e[1]*=t,e[5]*=t,e[9]*=t,e[13]*=t,e[2]*=t,e[6]*=t,e[10]*=t,e[14]*=t,e[3]*=t,e[7]*=t,e[11]*=t,e[15]*=t,this}determinant(){const t=this.elements,e=t[0],i=t[4],s=t[8],r=t[12],o=t[1],a=t[5],l=t[9],u=t[13],c=t[2],h=t[6],d=t[10],p=t[14],g=t[3],v=t[7],m=t[11],f=t[15];return g*(+r*l*h-s*u*h-r*a*d+i*u*d+s*a*p-i*l*p)+v*(+e*l*p-e*u*d+r*o*d-s*o*p+s*u*c-r*l*c)+m*(+e*u*h-e*a*p-r*o*h+i*o*p+r*a*c-i*u*c)+f*(-s*a*c-e*l*h+e*a*d+s*o*h-i*o*d+i*l*c)}transpose(){const t=this.elements;let e;return e=t[1],t[1]=t[4],t[4]=e,e=t[2],t[2]=t[8],t[8]=e,e=t[6],t[6]=t[9],t[9]=e,e=t[3],t[3]=t[12],t[12]=e,e=t[7],t[7]=t[13],t[13]=e,e=t[11],t[11]=t[14],t[14]=e,this}setPosition(t,e,i){const s=this.elements;return t.isVector3?(s[12]=t.x,s[13]=t.y,s[14]=t.z):(s[12]=t,s[13]=e,s[14]=i),this}invert(){const t=this.elements,e=t[0],i=t[1],s=t[2],r=t[3],o=t[4],a=t[5],l=t[6],u=t[7],c=t[8],h=t[9],d=t[10],p=t[11],g=t[12],v=t[13],m=t[14],f=t[15],w=h*m*u-v*d*u+v*l*p-a*m*p-h*l*f+a*d*f,b=g*d*u-c*m*u-g*l*p+o*m*p+c*l*f-o*d*f,x=c*v*u-g*h*u+g*a*p-o*v*p-c*a*f+o*h*f,B=g*h*l-c*v*l-g*a*d+o*v*d+c*a*m-o*h*m,P=e*w+i*b+s*x+r*B;if(P===0)return this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);const D=1/P;return t[0]=w*D,t[1]=(v*d*r-h*m*r-v*s*p+i*m*p+h*s*f-i*d*f)*D,t[2]=(a*m*r-v*l*r+v*s*u-i*m*u-a*s*f+i*l*f)*D,t[3]=(h*l*r-a*d*r-h*s*u+i*d*u+a*s*p-i*l*p)*D,t[4]=b*D,t[5]=(c*m*r-g*d*r+g*s*p-e*m*p-c*s*f+e*d*f)*D,t[6]=(g*l*r-o*m*r-g*s*u+e*m*u+o*s*f-e*l*f)*D,t[7]=(o*d*r-c*l*r+c*s*u-e*d*u-o*s*p+e*l*p)*D,t[8]=x*D,t[9]=(g*h*r-c*v*r-g*i*p+e*v*p+c*i*f-e*h*f)*D,t[10]=(o*v*r-g*a*r+g*i*u-e*v*u-o*i*f+e*a*f)*D,t[11]=(c*a*r-o*h*r-c*i*u+e*h*u+o*i*p-e*a*p)*D,t[12]=B*D,t[13]=(c*v*s-g*h*s+g*i*d-e*v*d-c*i*m+e*h*m)*D,t[14]=(g*a*s-o*v*s-g*i*l+e*v*l+o*i*m-e*a*m)*D,t[15]=(o*h*s-c*a*s+c*i*l-e*h*l-o*i*d+e*a*d)*D,this}scale(t){const e=this.elements,i=t.x,s=t.y,r=t.z;return e[0]*=i,e[4]*=s,e[8]*=r,e[1]*=i,e[5]*=s,e[9]*=r,e[2]*=i,e[6]*=s,e[10]*=r,e[3]*=i,e[7]*=s,e[11]*=r,this}getMaxScaleOnAxis(){const t=this.elements,e=t[0]*t[0]+t[1]*t[1]+t[2]*t[2],i=t[4]*t[4]+t[5]*t[5]+t[6]*t[6],s=t[8]*t[8]+t[9]*t[9]+t[10]*t[10];return Math.sqrt(Math.max(e,i,s))}makeTranslation(t,e,i){return t.isVector3?this.set(1,0,0,t.x,0,1,0,t.y,0,0,1,t.z,0,0,0,1):this.set(1,0,0,t,0,1,0,e,0,0,1,i,0,0,0,1),this}makeRotationX(t){const e=Math.cos(t),i=Math.sin(t);return this.set(1,0,0,0,0,e,-i,0,0,i,e,0,0,0,0,1),this}makeRotationY(t){const e=Math.cos(t),i=Math.sin(t);return this.set(e,0,i,0,0,1,0,0,-i,0,e,0,0,0,0,1),this}makeRotationZ(t){const e=Math.cos(t),i=Math.sin(t);return this.set(e,-i,0,0,i,e,0,0,0,0,1,0,0,0,0,1),this}makeRotationAxis(t,e){const i=Math.cos(e),s=Math.sin(e),r=1-i,o=t.x,a=t.y,l=t.z,u=r*o,c=r*a;return this.set(u*o+i,u*a-s*l,u*l+s*a,0,u*a+s*l,c*a+i,c*l-s*o,0,u*l-s*a,c*l+s*o,r*l*l+i,0,0,0,0,1),this}makeScale(t,e,i){return this.set(t,0,0,0,0,e,0,0,0,0,i,0,0,0,0,1),this}makeShear(t,e,i,s,r,o){return this.set(1,i,r,0,t,1,o,0,e,s,1,0,0,0,0,1),this}compose(t,e,i){const s=this.elements,r=e._x,o=e._y,a=e._z,l=e._w,u=r+r,c=o+o,h=a+a,d=r*u,p=r*c,g=r*h,v=o*c,m=o*h,f=a*h,w=l*u,b=l*c,x=l*h,B=i.x,P=i.y,D=i.z;return s[0]=(1-(v+f))*B,s[1]=(p+x)*B,s[2]=(g-b)*B,s[3]=0,s[4]=(p-x)*P,s[5]=(1-(d+f))*P,s[6]=(m+w)*P,s[7]=0,s[8]=(g+b)*D,s[9]=(m-w)*D,s[10]=(1-(d+v))*D,s[11]=0,s[12]=t.x,s[13]=t.y,s[14]=t.z,s[15]=1,this}decompose(t,e,i){const s=this.elements;let r=ps.set(s[0],s[1],s[2]).length();const o=ps.set(s[4],s[5],s[6]).length(),a=ps.set(s[8],s[9],s[10]).length();this.determinant()<0&&(r=-r),t.x=s[12],t.y=s[13],t.z=s[14],pn.copy(this);const u=1/r,c=1/o,h=1/a;return pn.elements[0]*=u,pn.elements[1]*=u,pn.elements[2]*=u,pn.elements[4]*=c,pn.elements[5]*=c,pn.elements[6]*=c,pn.elements[8]*=h,pn.elements[9]*=h,pn.elements[10]*=h,e.setFromRotationMatrix(pn),i.x=r,i.y=o,i.z=a,this}makePerspective(t,e,i,s,r,o,a=oi){const l=this.elements,u=2*r/(e-t),c=2*r/(i-s),h=(e+t)/(e-t),d=(i+s)/(i-s);let p,g;if(a===oi)p=-(o+r)/(o-r),g=-2*o*r/(o-r);else if(a===Bo)p=-o/(o-r),g=-o*r/(o-r);else throw new Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: "+a);return l[0]=u,l[4]=0,l[8]=h,l[12]=0,l[1]=0,l[5]=c,l[9]=d,l[13]=0,l[2]=0,l[6]=0,l[10]=p,l[14]=g,l[3]=0,l[7]=0,l[11]=-1,l[15]=0,this}makeOrthographic(t,e,i,s,r,o,a=oi){const l=this.elements,u=1/(e-t),c=1/(i-s),h=1/(o-r),d=(e+t)*u,p=(i+s)*c;let g,v;if(a===oi)g=(o+r)*h,v=-2*h;else if(a===Bo)g=r*h,v=-1*h;else throw new Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: "+a);return l[0]=2*u,l[4]=0,l[8]=0,l[12]=-d,l[1]=0,l[5]=2*c,l[9]=0,l[13]=-p,l[2]=0,l[6]=0,l[10]=v,l[14]=-g,l[3]=0,l[7]=0,l[11]=0,l[15]=1,this}equals(t){const e=this.elements,i=t.elements;for(let s=0;s<16;s++)if(e[s]!==i[s])return!1;return!0}fromArray(t,e=0){for(let i=0;i<16;i++)this.elements[i]=t[i+e];return this}toArray(t=[],e=0){const i=this.elements;return t[e]=i[0],t[e+1]=i[1],t[e+2]=i[2],t[e+3]=i[3],t[e+4]=i[4],t[e+5]=i[5],t[e+6]=i[6],t[e+7]=i[7],t[e+8]=i[8],t[e+9]=i[9],t[e+10]=i[10],t[e+11]=i[11],t[e+12]=i[12],t[e+13]=i[13],t[e+14]=i[14],t[e+15]=i[15],t}}const ps=new G,pn=new ue,Bg=new G(0,0,0),zg=new G(1,1,1),gi=new G,Yr=new G,Ke=new G,Ju=new ue,Qu=new Di;class Gn{constructor(t=0,e=0,i=0,s=Gn.DEFAULT_ORDER){this.isEuler=!0,this._x=t,this._y=e,this._z=i,this._order=s}get x(){return this._x}set x(t){this._x=t,this._onChangeCallback()}get y(){return this._y}set y(t){this._y=t,this._onChangeCallback()}get z(){return this._z}set z(t){this._z=t,this._onChangeCallback()}get order(){return this._order}set order(t){this._order=t,this._onChangeCallback()}set(t,e,i,s=this._order){return this._x=t,this._y=e,this._z=i,this._order=s,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._order)}copy(t){return this._x=t._x,this._y=t._y,this._z=t._z,this._order=t._order,this._onChangeCallback(),this}setFromRotationMatrix(t,e=this._order,i=!0){const s=t.elements,r=s[0],o=s[4],a=s[8],l=s[1],u=s[5],c=s[9],h=s[2],d=s[6],p=s[10];switch(e){case"XYZ":this._y=Math.asin(Fe(a,-1,1)),Math.abs(a)<.9999999?(this._x=Math.atan2(-c,p),this._z=Math.atan2(-o,r)):(this._x=Math.atan2(d,u),this._z=0);break;case"YXZ":this._x=Math.asin(-Fe(c,-1,1)),Math.abs(c)<.9999999?(this._y=Math.atan2(a,p),this._z=Math.atan2(l,u)):(this._y=Math.atan2(-h,r),this._z=0);break;case"ZXY":this._x=Math.asin(Fe(d,-1,1)),Math.abs(d)<.9999999?(this._y=Math.atan2(-h,p),this._z=Math.atan2(-o,u)):(this._y=0,this._z=Math.atan2(l,r));break;case"ZYX":this._y=Math.asin(-Fe(h,-1,1)),Math.abs(h)<.9999999?(this._x=Math.atan2(d,p),this._z=Math.atan2(l,r)):(this._x=0,this._z=Math.atan2(-o,u));break;case"YZX":this._z=Math.asin(Fe(l,-1,1)),Math.abs(l)<.9999999?(this._x=Math.atan2(-c,u),this._y=Math.atan2(-h,r)):(this._x=0,this._y=Math.atan2(a,p));break;case"XZY":this._z=Math.asin(-Fe(o,-1,1)),Math.abs(o)<.9999999?(this._x=Math.atan2(d,u),this._y=Math.atan2(a,r)):(this._x=Math.atan2(-c,p),this._y=0);break;default:console.warn("THREE.Euler: .setFromRotationMatrix() encountered an unknown order: "+e)}return this._order=e,i===!0&&this._onChangeCallback(),this}setFromQuaternion(t,e,i){return Ju.makeRotationFromQuaternion(t),this.setFromRotationMatrix(Ju,e,i)}setFromVector3(t,e=this._order){return this.set(t.x,t.y,t.z,e)}reorder(t){return Qu.setFromEuler(this),this.setFromQuaternion(Qu,t)}equals(t){return t._x===this._x&&t._y===this._y&&t._z===this._z&&t._order===this._order}fromArray(t){return this._x=t[0],this._y=t[1],this._z=t[2],t[3]!==void 0&&(this._order=t[3]),this._onChangeCallback(),this}toArray(t=[],e=0){return t[e]=this._x,t[e+1]=this._y,t[e+2]=this._z,t[e+3]=this._order,t}_onChange(t){return this._onChangeCallback=t,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._order}}Gn.DEFAULT_ORDER="XYZ";class Ld{constructor(){this.mask=1}set(t){this.mask=(1<<t|0)>>>0}enable(t){this.mask|=1<<t|0}enableAll(){this.mask=-1}toggle(t){this.mask^=1<<t|0}disable(t){this.mask&=~(1<<t|0)}disableAll(){this.mask=0}test(t){return(this.mask&t.mask)!==0}isEnabled(t){return(this.mask&(1<<t|0))!==0}}let kg=0;const th=new G,ms=new Di,Jn=new ue,jr=new G,Zs=new G,Hg=new G,Vg=new Di,eh=new G(1,0,0),nh=new G(0,1,0),ih=new G(0,0,1),sh={type:"added"},Gg={type:"removed"},_s={type:"childadded",child:null},Ia={type:"childremoved",child:null};class Ae extends rs{constructor(){super(),this.isObject3D=!0,Object.defineProperty(this,"id",{value:kg++}),this.uuid=Pr(),this.name="",this.type="Object3D",this.parent=null,this.children=[],this.up=Ae.DEFAULT_UP.clone();const t=new G,e=new Gn,i=new Di,s=new G(1,1,1);function r(){i.setFromEuler(e,!1)}function o(){e.setFromQuaternion(i,void 0,!1)}e._onChange(r),i._onChange(o),Object.defineProperties(this,{position:{configurable:!0,enumerable:!0,value:t},rotation:{configurable:!0,enumerable:!0,value:e},quaternion:{configurable:!0,enumerable:!0,value:i},scale:{configurable:!0,enumerable:!0,value:s},modelViewMatrix:{value:new ue},normalMatrix:{value:new Wt}}),this.matrix=new ue,this.matrixWorld=new ue,this.matrixAutoUpdate=Ae.DEFAULT_MATRIX_AUTO_UPDATE,this.matrixWorldAutoUpdate=Ae.DEFAULT_MATRIX_WORLD_AUTO_UPDATE,this.matrixWorldNeedsUpdate=!1,this.layers=new Ld,this.visible=!0,this.castShadow=!1,this.receiveShadow=!1,this.frustumCulled=!0,this.renderOrder=0,this.animations=[],this.userData={}}onBeforeShadow(){}onAfterShadow(){}onBeforeRender(){}onAfterRender(){}applyMatrix4(t){this.matrixAutoUpdate&&this.updateMatrix(),this.matrix.premultiply(t),this.matrix.decompose(this.position,this.quaternion,this.scale)}applyQuaternion(t){return this.quaternion.premultiply(t),this}setRotationFromAxisAngle(t,e){this.quaternion.setFromAxisAngle(t,e)}setRotationFromEuler(t){this.quaternion.setFromEuler(t,!0)}setRotationFromMatrix(t){this.quaternion.setFromRotationMatrix(t)}setRotationFromQuaternion(t){this.quaternion.copy(t)}rotateOnAxis(t,e){return ms.setFromAxisAngle(t,e),this.quaternion.multiply(ms),this}rotateOnWorldAxis(t,e){return ms.setFromAxisAngle(t,e),this.quaternion.premultiply(ms),this}rotateX(t){return this.rotateOnAxis(eh,t)}rotateY(t){return this.rotateOnAxis(nh,t)}rotateZ(t){return this.rotateOnAxis(ih,t)}translateOnAxis(t,e){return th.copy(t).applyQuaternion(this.quaternion),this.position.add(th.multiplyScalar(e)),this}translateX(t){return this.translateOnAxis(eh,t)}translateY(t){return this.translateOnAxis(nh,t)}translateZ(t){return this.translateOnAxis(ih,t)}localToWorld(t){return this.updateWorldMatrix(!0,!1),t.applyMatrix4(this.matrixWorld)}worldToLocal(t){return this.updateWorldMatrix(!0,!1),t.applyMatrix4(Jn.copy(this.matrixWorld).invert())}lookAt(t,e,i){t.isVector3?jr.copy(t):jr.set(t,e,i);const s=this.parent;this.updateWorldMatrix(!0,!1),Zs.setFromMatrixPosition(this.matrixWorld),this.isCamera||this.isLight?Jn.lookAt(Zs,jr,this.up):Jn.lookAt(jr,Zs,this.up),this.quaternion.setFromRotationMatrix(Jn),s&&(Jn.extractRotation(s.matrixWorld),ms.setFromRotationMatrix(Jn),this.quaternion.premultiply(ms.invert()))}add(t){if(arguments.length>1){for(let e=0;e<arguments.length;e++)this.add(arguments[e]);return this}return t===this?(console.error("THREE.Object3D.add: object can't be added as a child of itself.",t),this):(t&&t.isObject3D?(t.removeFromParent(),t.parent=this,this.children.push(t),t.dispatchEvent(sh),_s.child=t,this.dispatchEvent(_s),_s.child=null):console.error("THREE.Object3D.add: object not an instance of THREE.Object3D.",t),this)}remove(t){if(arguments.length>1){for(let i=0;i<arguments.length;i++)this.remove(arguments[i]);return this}const e=this.children.indexOf(t);return e!==-1&&(t.parent=null,this.children.splice(e,1),t.dispatchEvent(Gg),Ia.child=t,this.dispatchEvent(Ia),Ia.child=null),this}removeFromParent(){const t=this.parent;return t!==null&&t.remove(this),this}clear(){return this.remove(...this.children)}attach(t){return this.updateWorldMatrix(!0,!1),Jn.copy(this.matrixWorld).invert(),t.parent!==null&&(t.parent.updateWorldMatrix(!0,!1),Jn.multiply(t.parent.matrixWorld)),t.applyMatrix4(Jn),t.removeFromParent(),t.parent=this,this.children.push(t),t.updateWorldMatrix(!1,!0),t.dispatchEvent(sh),_s.child=t,this.dispatchEvent(_s),_s.child=null,this}getObjectById(t){return this.getObjectByProperty("id",t)}getObjectByName(t){return this.getObjectByProperty("name",t)}getObjectByProperty(t,e){if(this[t]===e)return this;for(let i=0,s=this.children.length;i<s;i++){const o=this.children[i].getObjectByProperty(t,e);if(o!==void 0)return o}}getObjectsByProperty(t,e,i=[]){this[t]===e&&i.push(this);const s=this.children;for(let r=0,o=s.length;r<o;r++)s[r].getObjectsByProperty(t,e,i);return i}getWorldPosition(t){return this.updateWorldMatrix(!0,!1),t.setFromMatrixPosition(this.matrixWorld)}getWorldQuaternion(t){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(Zs,t,Hg),t}getWorldScale(t){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(Zs,Vg,t),t}getWorldDirection(t){this.updateWorldMatrix(!0,!1);const e=this.matrixWorld.elements;return t.set(e[8],e[9],e[10]).normalize()}raycast(){}traverse(t){t(this);const e=this.children;for(let i=0,s=e.length;i<s;i++)e[i].traverse(t)}traverseVisible(t){if(this.visible===!1)return;t(this);const e=this.children;for(let i=0,s=e.length;i<s;i++)e[i].traverseVisible(t)}traverseAncestors(t){const e=this.parent;e!==null&&(t(e),e.traverseAncestors(t))}updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale),this.matrixWorldNeedsUpdate=!0}updateMatrixWorld(t){this.matrixAutoUpdate&&this.updateMatrix(),(this.matrixWorldNeedsUpdate||t)&&(this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),this.matrixWorldNeedsUpdate=!1,t=!0);const e=this.children;for(let i=0,s=e.length;i<s;i++)e[i].updateMatrixWorld(t)}updateWorldMatrix(t,e){const i=this.parent;if(t===!0&&i!==null&&i.updateWorldMatrix(!0,!1),this.matrixAutoUpdate&&this.updateMatrix(),this.matrixWorldAutoUpdate===!0&&(this.parent===null?this.matrixWorld.copy(this.matrix):this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix)),e===!0){const s=this.children;for(let r=0,o=s.length;r<o;r++)s[r].updateWorldMatrix(!1,!0)}}toJSON(t){const e=t===void 0||typeof t=="string",i={};e&&(t={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}},i.metadata={version:4.6,type:"Object",generator:"Object3D.toJSON"});const s={};s.uuid=this.uuid,s.type=this.type,this.name!==""&&(s.name=this.name),this.castShadow===!0&&(s.castShadow=!0),this.receiveShadow===!0&&(s.receiveShadow=!0),this.visible===!1&&(s.visible=!1),this.frustumCulled===!1&&(s.frustumCulled=!1),this.renderOrder!==0&&(s.renderOrder=this.renderOrder),Object.keys(this.userData).length>0&&(s.userData=this.userData),s.layers=this.layers.mask,s.matrix=this.matrix.toArray(),s.up=this.up.toArray(),this.matrixAutoUpdate===!1&&(s.matrixAutoUpdate=!1),this.isInstancedMesh&&(s.type="InstancedMesh",s.count=this.count,s.instanceMatrix=this.instanceMatrix.toJSON(),this.instanceColor!==null&&(s.instanceColor=this.instanceColor.toJSON())),this.isBatchedMesh&&(s.type="BatchedMesh",s.perObjectFrustumCulled=this.perObjectFrustumCulled,s.sortObjects=this.sortObjects,s.drawRanges=this._drawRanges,s.reservedRanges=this._reservedRanges,s.visibility=this._visibility,s.active=this._active,s.bounds=this._bounds.map(a=>({boxInitialized:a.boxInitialized,boxMin:a.box.min.toArray(),boxMax:a.box.max.toArray(),sphereInitialized:a.sphereInitialized,sphereRadius:a.sphere.radius,sphereCenter:a.sphere.center.toArray()})),s.maxInstanceCount=this._maxInstanceCount,s.maxVertexCount=this._maxVertexCount,s.maxIndexCount=this._maxIndexCount,s.geometryInitialized=this._geometryInitialized,s.geometryCount=this._geometryCount,s.matricesTexture=this._matricesTexture.toJSON(t),this._colorsTexture!==null&&(s.colorsTexture=this._colorsTexture.toJSON(t)),this.boundingSphere!==null&&(s.boundingSphere={center:s.boundingSphere.center.toArray(),radius:s.boundingSphere.radius}),this.boundingBox!==null&&(s.boundingBox={min:s.boundingBox.min.toArray(),max:s.boundingBox.max.toArray()}));function r(a,l){return a[l.uuid]===void 0&&(a[l.uuid]=l.toJSON(t)),l.uuid}if(this.isScene)this.background&&(this.background.isColor?s.background=this.background.toJSON():this.background.isTexture&&(s.background=this.background.toJSON(t).uuid)),this.environment&&this.environment.isTexture&&this.environment.isRenderTargetTexture!==!0&&(s.environment=this.environment.toJSON(t).uuid);else if(this.isMesh||this.isLine||this.isPoints){s.geometry=r(t.geometries,this.geometry);const a=this.geometry.parameters;if(a!==void 0&&a.shapes!==void 0){const l=a.shapes;if(Array.isArray(l))for(let u=0,c=l.length;u<c;u++){const h=l[u];r(t.shapes,h)}else r(t.shapes,l)}}if(this.isSkinnedMesh&&(s.bindMode=this.bindMode,s.bindMatrix=this.bindMatrix.toArray(),this.skeleton!==void 0&&(r(t.skeletons,this.skeleton),s.skeleton=this.skeleton.uuid)),this.material!==void 0)if(Array.isArray(this.material)){const a=[];for(let l=0,u=this.material.length;l<u;l++)a.push(r(t.materials,this.material[l]));s.material=a}else s.material=r(t.materials,this.material);if(this.children.length>0){s.children=[];for(let a=0;a<this.children.length;a++)s.children.push(this.children[a].toJSON(t).object)}if(this.animations.length>0){s.animations=[];for(let a=0;a<this.animations.length;a++){const l=this.animations[a];s.animations.push(r(t.animations,l))}}if(e){const a=o(t.geometries),l=o(t.materials),u=o(t.textures),c=o(t.images),h=o(t.shapes),d=o(t.skeletons),p=o(t.animations),g=o(t.nodes);a.length>0&&(i.geometries=a),l.length>0&&(i.materials=l),u.length>0&&(i.textures=u),c.length>0&&(i.images=c),h.length>0&&(i.shapes=h),d.length>0&&(i.skeletons=d),p.length>0&&(i.animations=p),g.length>0&&(i.nodes=g)}return i.object=s,i;function o(a){const l=[];for(const u in a){const c=a[u];delete c.metadata,l.push(c)}return l}}clone(t){return new this.constructor().copy(this,t)}copy(t,e=!0){if(this.name=t.name,this.up.copy(t.up),this.position.copy(t.position),this.rotation.order=t.rotation.order,this.quaternion.copy(t.quaternion),this.scale.copy(t.scale),this.matrix.copy(t.matrix),this.matrixWorld.copy(t.matrixWorld),this.matrixAutoUpdate=t.matrixAutoUpdate,this.matrixWorldAutoUpdate=t.matrixWorldAutoUpdate,this.matrixWorldNeedsUpdate=t.matrixWorldNeedsUpdate,this.layers.mask=t.layers.mask,this.visible=t.visible,this.castShadow=t.castShadow,this.receiveShadow=t.receiveShadow,this.frustumCulled=t.frustumCulled,this.renderOrder=t.renderOrder,this.animations=t.animations.slice(),this.userData=JSON.parse(JSON.stringify(t.userData)),e===!0)for(let i=0;i<t.children.length;i++){const s=t.children[i];this.add(s.clone())}return this}}Ae.DEFAULT_UP=new G(0,1,0);Ae.DEFAULT_MATRIX_AUTO_UPDATE=!0;Ae.DEFAULT_MATRIX_WORLD_AUTO_UPDATE=!0;const mn=new G,Qn=new G,Ua=new G,ti=new G,gs=new G,vs=new G,rh=new G,Na=new G,Oa=new G,Fa=new G,Ba=new ge,za=new ge,ka=new ge;class xn{constructor(t=new G,e=new G,i=new G){this.a=t,this.b=e,this.c=i}static getNormal(t,e,i,s){s.subVectors(i,e),mn.subVectors(t,e),s.cross(mn);const r=s.lengthSq();return r>0?s.multiplyScalar(1/Math.sqrt(r)):s.set(0,0,0)}static getBarycoord(t,e,i,s,r){mn.subVectors(s,e),Qn.subVectors(i,e),Ua.subVectors(t,e);const o=mn.dot(mn),a=mn.dot(Qn),l=mn.dot(Ua),u=Qn.dot(Qn),c=Qn.dot(Ua),h=o*u-a*a;if(h===0)return r.set(0,0,0),null;const d=1/h,p=(u*l-a*c)*d,g=(o*c-a*l)*d;return r.set(1-p-g,g,p)}static containsPoint(t,e,i,s){return this.getBarycoord(t,e,i,s,ti)===null?!1:ti.x>=0&&ti.y>=0&&ti.x+ti.y<=1}static getInterpolation(t,e,i,s,r,o,a,l){return this.getBarycoord(t,e,i,s,ti)===null?(l.x=0,l.y=0,"z"in l&&(l.z=0),"w"in l&&(l.w=0),null):(l.setScalar(0),l.addScaledVector(r,ti.x),l.addScaledVector(o,ti.y),l.addScaledVector(a,ti.z),l)}static getInterpolatedAttribute(t,e,i,s,r,o){return Ba.setScalar(0),za.setScalar(0),ka.setScalar(0),Ba.fromBufferAttribute(t,e),za.fromBufferAttribute(t,i),ka.fromBufferAttribute(t,s),o.setScalar(0),o.addScaledVector(Ba,r.x),o.addScaledVector(za,r.y),o.addScaledVector(ka,r.z),o}static isFrontFacing(t,e,i,s){return mn.subVectors(i,e),Qn.subVectors(t,e),mn.cross(Qn).dot(s)<0}set(t,e,i){return this.a.copy(t),this.b.copy(e),this.c.copy(i),this}setFromPointsAndIndices(t,e,i,s){return this.a.copy(t[e]),this.b.copy(t[i]),this.c.copy(t[s]),this}setFromAttributeAndIndices(t,e,i,s){return this.a.fromBufferAttribute(t,e),this.b.fromBufferAttribute(t,i),this.c.fromBufferAttribute(t,s),this}clone(){return new this.constructor().copy(this)}copy(t){return this.a.copy(t.a),this.b.copy(t.b),this.c.copy(t.c),this}getArea(){return mn.subVectors(this.c,this.b),Qn.subVectors(this.a,this.b),mn.cross(Qn).length()*.5}getMidpoint(t){return t.addVectors(this.a,this.b).add(this.c).multiplyScalar(1/3)}getNormal(t){return xn.getNormal(this.a,this.b,this.c,t)}getPlane(t){return t.setFromCoplanarPoints(this.a,this.b,this.c)}getBarycoord(t,e){return xn.getBarycoord(t,this.a,this.b,this.c,e)}getInterpolation(t,e,i,s,r){return xn.getInterpolation(t,this.a,this.b,this.c,e,i,s,r)}containsPoint(t){return xn.containsPoint(t,this.a,this.b,this.c)}isFrontFacing(t){return xn.isFrontFacing(this.a,this.b,this.c,t)}intersectsBox(t){return t.intersectsTriangle(this)}closestPointToPoint(t,e){const i=this.a,s=this.b,r=this.c;let o,a;gs.subVectors(s,i),vs.subVectors(r,i),Na.subVectors(t,i);const l=gs.dot(Na),u=vs.dot(Na);if(l<=0&&u<=0)return e.copy(i);Oa.subVectors(t,s);const c=gs.dot(Oa),h=vs.dot(Oa);if(c>=0&&h<=c)return e.copy(s);const d=l*h-c*u;if(d<=0&&l>=0&&c<=0)return o=l/(l-c),e.copy(i).addScaledVector(gs,o);Fa.subVectors(t,r);const p=gs.dot(Fa),g=vs.dot(Fa);if(g>=0&&p<=g)return e.copy(r);const v=p*u-l*g;if(v<=0&&u>=0&&g<=0)return a=u/(u-g),e.copy(i).addScaledVector(vs,a);const m=c*g-p*h;if(m<=0&&h-c>=0&&p-g>=0)return rh.subVectors(r,s),a=(h-c)/(h-c+(p-g)),e.copy(s).addScaledVector(rh,a);const f=1/(m+v+d);return o=v*f,a=d*f,e.copy(i).addScaledVector(gs,o).addScaledVector(vs,a)}equals(t){return t.a.equals(this.a)&&t.b.equals(this.b)&&t.c.equals(this.c)}}const Id={aliceblue:15792383,antiquewhite:16444375,aqua:65535,aquamarine:8388564,azure:15794175,beige:16119260,bisque:16770244,black:0,blanchedalmond:16772045,blue:255,blueviolet:9055202,brown:10824234,burlywood:14596231,cadetblue:6266528,chartreuse:8388352,chocolate:13789470,coral:16744272,cornflowerblue:6591981,cornsilk:16775388,crimson:14423100,cyan:65535,darkblue:139,darkcyan:35723,darkgoldenrod:12092939,darkgray:11119017,darkgreen:25600,darkgrey:11119017,darkkhaki:12433259,darkmagenta:9109643,darkolivegreen:5597999,darkorange:16747520,darkorchid:10040012,darkred:9109504,darksalmon:15308410,darkseagreen:9419919,darkslateblue:4734347,darkslategray:3100495,darkslategrey:3100495,darkturquoise:52945,darkviolet:9699539,deeppink:16716947,deepskyblue:49151,dimgray:6908265,dimgrey:6908265,dodgerblue:2003199,firebrick:11674146,floralwhite:16775920,forestgreen:2263842,fuchsia:16711935,gainsboro:14474460,ghostwhite:16316671,gold:16766720,goldenrod:14329120,gray:8421504,green:32768,greenyellow:11403055,grey:8421504,honeydew:15794160,hotpink:16738740,indianred:13458524,indigo:4915330,ivory:16777200,khaki:15787660,lavender:15132410,lavenderblush:16773365,lawngreen:8190976,lemonchiffon:16775885,lightblue:11393254,lightcoral:15761536,lightcyan:14745599,lightgoldenrodyellow:16448210,lightgray:13882323,lightgreen:9498256,lightgrey:13882323,lightpink:16758465,lightsalmon:16752762,lightseagreen:2142890,lightskyblue:8900346,lightslategray:7833753,lightslategrey:7833753,lightsteelblue:11584734,lightyellow:16777184,lime:65280,limegreen:3329330,linen:16445670,magenta:16711935,maroon:8388608,mediumaquamarine:6737322,mediumblue:205,mediumorchid:12211667,mediumpurple:9662683,mediumseagreen:3978097,mediumslateblue:8087790,mediumspringgreen:64154,mediumturquoise:4772300,mediumvioletred:13047173,midnightblue:1644912,mintcream:16121850,mistyrose:16770273,moccasin:16770229,navajowhite:16768685,navy:128,oldlace:16643558,olive:8421376,olivedrab:7048739,orange:16753920,orangered:16729344,orchid:14315734,palegoldenrod:15657130,palegreen:10025880,paleturquoise:11529966,palevioletred:14381203,papayawhip:16773077,peachpuff:16767673,peru:13468991,pink:16761035,plum:14524637,powderblue:11591910,purple:8388736,rebeccapurple:6697881,red:16711680,rosybrown:12357519,royalblue:4286945,saddlebrown:9127187,salmon:16416882,sandybrown:16032864,seagreen:3050327,seashell:16774638,sienna:10506797,silver:12632256,skyblue:8900331,slateblue:6970061,slategray:7372944,slategrey:7372944,snow:16775930,springgreen:65407,steelblue:4620980,tan:13808780,teal:32896,thistle:14204888,tomato:16737095,turquoise:4251856,violet:15631086,wheat:16113331,white:16777215,whitesmoke:16119285,yellow:16776960,yellowgreen:10145074},vi={h:0,s:0,l:0},Kr={h:0,s:0,l:0};function Ha(n,t,e){return e<0&&(e+=1),e>1&&(e-=1),e<1/6?n+(t-n)*6*e:e<1/2?t:e<2/3?n+(t-n)*6*(2/3-e):n}class $t{constructor(t,e,i){return this.isColor=!0,this.r=1,this.g=1,this.b=1,this.set(t,e,i)}set(t,e,i){if(e===void 0&&i===void 0){const s=t;s&&s.isColor?this.copy(s):typeof s=="number"?this.setHex(s):typeof s=="string"&&this.setStyle(s)}else this.setRGB(t,e,i);return this}setScalar(t){return this.r=t,this.g=t,this.b=t,this}setHex(t,e=rn){return t=Math.floor(t),this.r=(t>>16&255)/255,this.g=(t>>8&255)/255,this.b=(t&255)/255,Jt.toWorkingColorSpace(this,e),this}setRGB(t,e,i,s=Jt.workingColorSpace){return this.r=t,this.g=e,this.b=i,Jt.toWorkingColorSpace(this,s),this}setHSL(t,e,i,s=Jt.workingColorSpace){if(t=Ag(t,1),e=Fe(e,0,1),i=Fe(i,0,1),e===0)this.r=this.g=this.b=i;else{const r=i<=.5?i*(1+e):i+e-i*e,o=2*i-r;this.r=Ha(o,r,t+1/3),this.g=Ha(o,r,t),this.b=Ha(o,r,t-1/3)}return Jt.toWorkingColorSpace(this,s),this}setStyle(t,e=rn){function i(r){r!==void 0&&parseFloat(r)<1&&console.warn("THREE.Color: Alpha component of "+t+" will be ignored.")}let s;if(s=/^(\w+)\(([^\)]*)\)/.exec(t)){let r;const o=s[1],a=s[2];switch(o){case"rgb":case"rgba":if(r=/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return i(r[4]),this.setRGB(Math.min(255,parseInt(r[1],10))/255,Math.min(255,parseInt(r[2],10))/255,Math.min(255,parseInt(r[3],10))/255,e);if(r=/^\s*(\d+)\%\s*,\s*(\d+)\%\s*,\s*(\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return i(r[4]),this.setRGB(Math.min(100,parseInt(r[1],10))/100,Math.min(100,parseInt(r[2],10))/100,Math.min(100,parseInt(r[3],10))/100,e);break;case"hsl":case"hsla":if(r=/^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\%\s*,\s*(\d*\.?\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return i(r[4]),this.setHSL(parseFloat(r[1])/360,parseFloat(r[2])/100,parseFloat(r[3])/100,e);break;default:console.warn("THREE.Color: Unknown color model "+t)}}else if(s=/^\#([A-Fa-f\d]+)$/.exec(t)){const r=s[1],o=r.length;if(o===3)return this.setRGB(parseInt(r.charAt(0),16)/15,parseInt(r.charAt(1),16)/15,parseInt(r.charAt(2),16)/15,e);if(o===6)return this.setHex(parseInt(r,16),e);console.warn("THREE.Color: Invalid hex color "+t)}else if(t&&t.length>0)return this.setColorName(t,e);return this}setColorName(t,e=rn){const i=Id[t.toLowerCase()];return i!==void 0?this.setHex(i,e):console.warn("THREE.Color: Unknown color "+t),this}clone(){return new this.constructor(this.r,this.g,this.b)}copy(t){return this.r=t.r,this.g=t.g,this.b=t.b,this}copySRGBToLinear(t){return this.r=ai(t.r),this.g=ai(t.g),this.b=ai(t.b),this}copyLinearToSRGB(t){return this.r=Ls(t.r),this.g=Ls(t.g),this.b=Ls(t.b),this}convertSRGBToLinear(){return this.copySRGBToLinear(this),this}convertLinearToSRGB(){return this.copyLinearToSRGB(this),this}getHex(t=rn){return Jt.fromWorkingColorSpace(Pe.copy(this),t),Math.round(Fe(Pe.r*255,0,255))*65536+Math.round(Fe(Pe.g*255,0,255))*256+Math.round(Fe(Pe.b*255,0,255))}getHexString(t=rn){return("000000"+this.getHex(t).toString(16)).slice(-6)}getHSL(t,e=Jt.workingColorSpace){Jt.fromWorkingColorSpace(Pe.copy(this),e);const i=Pe.r,s=Pe.g,r=Pe.b,o=Math.max(i,s,r),a=Math.min(i,s,r);let l,u;const c=(a+o)/2;if(a===o)l=0,u=0;else{const h=o-a;switch(u=c<=.5?h/(o+a):h/(2-o-a),o){case i:l=(s-r)/h+(s<r?6:0);break;case s:l=(r-i)/h+2;break;case r:l=(i-s)/h+4;break}l/=6}return t.h=l,t.s=u,t.l=c,t}getRGB(t,e=Jt.workingColorSpace){return Jt.fromWorkingColorSpace(Pe.copy(this),e),t.r=Pe.r,t.g=Pe.g,t.b=Pe.b,t}getStyle(t=rn){Jt.fromWorkingColorSpace(Pe.copy(this),t);const e=Pe.r,i=Pe.g,s=Pe.b;return t!==rn?`color(${t} ${e.toFixed(3)} ${i.toFixed(3)} ${s.toFixed(3)})`:`rgb(${Math.round(e*255)},${Math.round(i*255)},${Math.round(s*255)})`}offsetHSL(t,e,i){return this.getHSL(vi),this.setHSL(vi.h+t,vi.s+e,vi.l+i)}add(t){return this.r+=t.r,this.g+=t.g,this.b+=t.b,this}addColors(t,e){return this.r=t.r+e.r,this.g=t.g+e.g,this.b=t.b+e.b,this}addScalar(t){return this.r+=t,this.g+=t,this.b+=t,this}sub(t){return this.r=Math.max(0,this.r-t.r),this.g=Math.max(0,this.g-t.g),this.b=Math.max(0,this.b-t.b),this}multiply(t){return this.r*=t.r,this.g*=t.g,this.b*=t.b,this}multiplyScalar(t){return this.r*=t,this.g*=t,this.b*=t,this}lerp(t,e){return this.r+=(t.r-this.r)*e,this.g+=(t.g-this.g)*e,this.b+=(t.b-this.b)*e,this}lerpColors(t,e,i){return this.r=t.r+(e.r-t.r)*i,this.g=t.g+(e.g-t.g)*i,this.b=t.b+(e.b-t.b)*i,this}lerpHSL(t,e){this.getHSL(vi),t.getHSL(Kr);const i=ba(vi.h,Kr.h,e),s=ba(vi.s,Kr.s,e),r=ba(vi.l,Kr.l,e);return this.setHSL(i,s,r),this}setFromVector3(t){return this.r=t.x,this.g=t.y,this.b=t.z,this}applyMatrix3(t){const e=this.r,i=this.g,s=this.b,r=t.elements;return this.r=r[0]*e+r[3]*i+r[6]*s,this.g=r[1]*e+r[4]*i+r[7]*s,this.b=r[2]*e+r[5]*i+r[8]*s,this}equals(t){return t.r===this.r&&t.g===this.g&&t.b===this.b}fromArray(t,e=0){return this.r=t[e],this.g=t[e+1],this.b=t[e+2],this}toArray(t=[],e=0){return t[e]=this.r,t[e+1]=this.g,t[e+2]=this.b,t}fromBufferAttribute(t,e){return this.r=t.getX(e),this.g=t.getY(e),this.b=t.getZ(e),this}toJSON(){return this.getHex()}*[Symbol.iterator](){yield this.r,yield this.g,yield this.b}}const Pe=new $t;$t.NAMES=Id;let Wg=0;class Lr extends rs{static get type(){return"Material"}get type(){return this.constructor.type}set type(t){}constructor(){super(),this.isMaterial=!0,Object.defineProperty(this,"id",{value:Wg++}),this.uuid=Pr(),this.name="",this.blending=Ps,this.side=Pi,this.vertexColors=!1,this.opacity=1,this.transparent=!1,this.alphaHash=!1,this.blendSrc=_l,this.blendDst=gl,this.blendEquation=qi,this.blendSrcAlpha=null,this.blendDstAlpha=null,this.blendEquationAlpha=null,this.blendColor=new $t(0,0,0),this.blendAlpha=0,this.depthFunc=Ns,this.depthTest=!0,this.depthWrite=!0,this.stencilWriteMask=255,this.stencilFunc=Vu,this.stencilRef=0,this.stencilFuncMask=255,this.stencilFail=cs,this.stencilZFail=cs,this.stencilZPass=cs,this.stencilWrite=!1,this.clippingPlanes=null,this.clipIntersection=!1,this.clipShadows=!1,this.shadowSide=null,this.colorWrite=!0,this.precision=null,this.polygonOffset=!1,this.polygonOffsetFactor=0,this.polygonOffsetUnits=0,this.dithering=!1,this.alphaToCoverage=!1,this.premultipliedAlpha=!1,this.forceSinglePass=!1,this.visible=!0,this.toneMapped=!0,this.userData={},this.version=0,this._alphaTest=0}get alphaTest(){return this._alphaTest}set alphaTest(t){this._alphaTest>0!=t>0&&this.version++,this._alphaTest=t}onBeforeRender(){}onBeforeCompile(){}customProgramCacheKey(){return this.onBeforeCompile.toString()}setValues(t){if(t!==void 0)for(const e in t){const i=t[e];if(i===void 0){console.warn(`THREE.Material: parameter '${e}' has value of undefined.`);continue}const s=this[e];if(s===void 0){console.warn(`THREE.Material: '${e}' is not a property of THREE.${this.type}.`);continue}s&&s.isColor?s.set(i):s&&s.isVector3&&i&&i.isVector3?s.copy(i):this[e]=i}}toJSON(t){const e=t===void 0||typeof t=="string";e&&(t={textures:{},images:{}});const i={metadata:{version:4.6,type:"Material",generator:"Material.toJSON"}};i.uuid=this.uuid,i.type=this.type,this.name!==""&&(i.name=this.name),this.color&&this.color.isColor&&(i.color=this.color.getHex()),this.roughness!==void 0&&(i.roughness=this.roughness),this.metalness!==void 0&&(i.metalness=this.metalness),this.sheen!==void 0&&(i.sheen=this.sheen),this.sheenColor&&this.sheenColor.isColor&&(i.sheenColor=this.sheenColor.getHex()),this.sheenRoughness!==void 0&&(i.sheenRoughness=this.sheenRoughness),this.emissive&&this.emissive.isColor&&(i.emissive=this.emissive.getHex()),this.emissiveIntensity!==void 0&&this.emissiveIntensity!==1&&(i.emissiveIntensity=this.emissiveIntensity),this.specular&&this.specular.isColor&&(i.specular=this.specular.getHex()),this.specularIntensity!==void 0&&(i.specularIntensity=this.specularIntensity),this.specularColor&&this.specularColor.isColor&&(i.specularColor=this.specularColor.getHex()),this.shininess!==void 0&&(i.shininess=this.shininess),this.clearcoat!==void 0&&(i.clearcoat=this.clearcoat),this.clearcoatRoughness!==void 0&&(i.clearcoatRoughness=this.clearcoatRoughness),this.clearcoatMap&&this.clearcoatMap.isTexture&&(i.clearcoatMap=this.clearcoatMap.toJSON(t).uuid),this.clearcoatRoughnessMap&&this.clearcoatRoughnessMap.isTexture&&(i.clearcoatRoughnessMap=this.clearcoatRoughnessMap.toJSON(t).uuid),this.clearcoatNormalMap&&this.clearcoatNormalMap.isTexture&&(i.clearcoatNormalMap=this.clearcoatNormalMap.toJSON(t).uuid,i.clearcoatNormalScale=this.clearcoatNormalScale.toArray()),this.dispersion!==void 0&&(i.dispersion=this.dispersion),this.iridescence!==void 0&&(i.iridescence=this.iridescence),this.iridescenceIOR!==void 0&&(i.iridescenceIOR=this.iridescenceIOR),this.iridescenceThicknessRange!==void 0&&(i.iridescenceThicknessRange=this.iridescenceThicknessRange),this.iridescenceMap&&this.iridescenceMap.isTexture&&(i.iridescenceMap=this.iridescenceMap.toJSON(t).uuid),this.iridescenceThicknessMap&&this.iridescenceThicknessMap.isTexture&&(i.iridescenceThicknessMap=this.iridescenceThicknessMap.toJSON(t).uuid),this.anisotropy!==void 0&&(i.anisotropy=this.anisotropy),this.anisotropyRotation!==void 0&&(i.anisotropyRotation=this.anisotropyRotation),this.anisotropyMap&&this.anisotropyMap.isTexture&&(i.anisotropyMap=this.anisotropyMap.toJSON(t).uuid),this.map&&this.map.isTexture&&(i.map=this.map.toJSON(t).uuid),this.matcap&&this.matcap.isTexture&&(i.matcap=this.matcap.toJSON(t).uuid),this.alphaMap&&this.alphaMap.isTexture&&(i.alphaMap=this.alphaMap.toJSON(t).uuid),this.lightMap&&this.lightMap.isTexture&&(i.lightMap=this.lightMap.toJSON(t).uuid,i.lightMapIntensity=this.lightMapIntensity),this.aoMap&&this.aoMap.isTexture&&(i.aoMap=this.aoMap.toJSON(t).uuid,i.aoMapIntensity=this.aoMapIntensity),this.bumpMap&&this.bumpMap.isTexture&&(i.bumpMap=this.bumpMap.toJSON(t).uuid,i.bumpScale=this.bumpScale),this.normalMap&&this.normalMap.isTexture&&(i.normalMap=this.normalMap.toJSON(t).uuid,i.normalMapType=this.normalMapType,i.normalScale=this.normalScale.toArray()),this.displacementMap&&this.displacementMap.isTexture&&(i.displacementMap=this.displacementMap.toJSON(t).uuid,i.displacementScale=this.displacementScale,i.displacementBias=this.displacementBias),this.roughnessMap&&this.roughnessMap.isTexture&&(i.roughnessMap=this.roughnessMap.toJSON(t).uuid),this.metalnessMap&&this.metalnessMap.isTexture&&(i.metalnessMap=this.metalnessMap.toJSON(t).uuid),this.emissiveMap&&this.emissiveMap.isTexture&&(i.emissiveMap=this.emissiveMap.toJSON(t).uuid),this.specularMap&&this.specularMap.isTexture&&(i.specularMap=this.specularMap.toJSON(t).uuid),this.specularIntensityMap&&this.specularIntensityMap.isTexture&&(i.specularIntensityMap=this.specularIntensityMap.toJSON(t).uuid),this.specularColorMap&&this.specularColorMap.isTexture&&(i.specularColorMap=this.specularColorMap.toJSON(t).uuid),this.envMap&&this.envMap.isTexture&&(i.envMap=this.envMap.toJSON(t).uuid,this.combine!==void 0&&(i.combine=this.combine)),this.envMapRotation!==void 0&&(i.envMapRotation=this.envMapRotation.toArray()),this.envMapIntensity!==void 0&&(i.envMapIntensity=this.envMapIntensity),this.reflectivity!==void 0&&(i.reflectivity=this.reflectivity),this.refractionRatio!==void 0&&(i.refractionRatio=this.refractionRatio),this.gradientMap&&this.gradientMap.isTexture&&(i.gradientMap=this.gradientMap.toJSON(t).uuid),this.transmission!==void 0&&(i.transmission=this.transmission),this.transmissionMap&&this.transmissionMap.isTexture&&(i.transmissionMap=this.transmissionMap.toJSON(t).uuid),this.thickness!==void 0&&(i.thickness=this.thickness),this.thicknessMap&&this.thicknessMap.isTexture&&(i.thicknessMap=this.thicknessMap.toJSON(t).uuid),this.attenuationDistance!==void 0&&this.attenuationDistance!==1/0&&(i.attenuationDistance=this.attenuationDistance),this.attenuationColor!==void 0&&(i.attenuationColor=this.attenuationColor.getHex()),this.size!==void 0&&(i.size=this.size),this.shadowSide!==null&&(i.shadowSide=this.shadowSide),this.sizeAttenuation!==void 0&&(i.sizeAttenuation=this.sizeAttenuation),this.blending!==Ps&&(i.blending=this.blending),this.side!==Pi&&(i.side=this.side),this.vertexColors===!0&&(i.vertexColors=!0),this.opacity<1&&(i.opacity=this.opacity),this.transparent===!0&&(i.transparent=!0),this.blendSrc!==_l&&(i.blendSrc=this.blendSrc),this.blendDst!==gl&&(i.blendDst=this.blendDst),this.blendEquation!==qi&&(i.blendEquation=this.blendEquation),this.blendSrcAlpha!==null&&(i.blendSrcAlpha=this.blendSrcAlpha),this.blendDstAlpha!==null&&(i.blendDstAlpha=this.blendDstAlpha),this.blendEquationAlpha!==null&&(i.blendEquationAlpha=this.blendEquationAlpha),this.blendColor&&this.blendColor.isColor&&(i.blendColor=this.blendColor.getHex()),this.blendAlpha!==0&&(i.blendAlpha=this.blendAlpha),this.depthFunc!==Ns&&(i.depthFunc=this.depthFunc),this.depthTest===!1&&(i.depthTest=this.depthTest),this.depthWrite===!1&&(i.depthWrite=this.depthWrite),this.colorWrite===!1&&(i.colorWrite=this.colorWrite),this.stencilWriteMask!==255&&(i.stencilWriteMask=this.stencilWriteMask),this.stencilFunc!==Vu&&(i.stencilFunc=this.stencilFunc),this.stencilRef!==0&&(i.stencilRef=this.stencilRef),this.stencilFuncMask!==255&&(i.stencilFuncMask=this.stencilFuncMask),this.stencilFail!==cs&&(i.stencilFail=this.stencilFail),this.stencilZFail!==cs&&(i.stencilZFail=this.stencilZFail),this.stencilZPass!==cs&&(i.stencilZPass=this.stencilZPass),this.stencilWrite===!0&&(i.stencilWrite=this.stencilWrite),this.rotation!==void 0&&this.rotation!==0&&(i.rotation=this.rotation),this.polygonOffset===!0&&(i.polygonOffset=!0),this.polygonOffsetFactor!==0&&(i.polygonOffsetFactor=this.polygonOffsetFactor),this.polygonOffsetUnits!==0&&(i.polygonOffsetUnits=this.polygonOffsetUnits),this.linewidth!==void 0&&this.linewidth!==1&&(i.linewidth=this.linewidth),this.dashSize!==void 0&&(i.dashSize=this.dashSize),this.gapSize!==void 0&&(i.gapSize=this.gapSize),this.scale!==void 0&&(i.scale=this.scale),this.dithering===!0&&(i.dithering=!0),this.alphaTest>0&&(i.alphaTest=this.alphaTest),this.alphaHash===!0&&(i.alphaHash=!0),this.alphaToCoverage===!0&&(i.alphaToCoverage=!0),this.premultipliedAlpha===!0&&(i.premultipliedAlpha=!0),this.forceSinglePass===!0&&(i.forceSinglePass=!0),this.wireframe===!0&&(i.wireframe=!0),this.wireframeLinewidth>1&&(i.wireframeLinewidth=this.wireframeLinewidth),this.wireframeLinecap!=="round"&&(i.wireframeLinecap=this.wireframeLinecap),this.wireframeLinejoin!=="round"&&(i.wireframeLinejoin=this.wireframeLinejoin),this.flatShading===!0&&(i.flatShading=!0),this.visible===!1&&(i.visible=!1),this.toneMapped===!1&&(i.toneMapped=!1),this.fog===!1&&(i.fog=!1),Object.keys(this.userData).length>0&&(i.userData=this.userData);function s(r){const o=[];for(const a in r){const l=r[a];delete l.metadata,o.push(l)}return o}if(e){const r=s(t.textures),o=s(t.images);r.length>0&&(i.textures=r),o.length>0&&(i.images=o)}return i}clone(){return new this.constructor().copy(this)}copy(t){this.name=t.name,this.blending=t.blending,this.side=t.side,this.vertexColors=t.vertexColors,this.opacity=t.opacity,this.transparent=t.transparent,this.blendSrc=t.blendSrc,this.blendDst=t.blendDst,this.blendEquation=t.blendEquation,this.blendSrcAlpha=t.blendSrcAlpha,this.blendDstAlpha=t.blendDstAlpha,this.blendEquationAlpha=t.blendEquationAlpha,this.blendColor.copy(t.blendColor),this.blendAlpha=t.blendAlpha,this.depthFunc=t.depthFunc,this.depthTest=t.depthTest,this.depthWrite=t.depthWrite,this.stencilWriteMask=t.stencilWriteMask,this.stencilFunc=t.stencilFunc,this.stencilRef=t.stencilRef,this.stencilFuncMask=t.stencilFuncMask,this.stencilFail=t.stencilFail,this.stencilZFail=t.stencilZFail,this.stencilZPass=t.stencilZPass,this.stencilWrite=t.stencilWrite;const e=t.clippingPlanes;let i=null;if(e!==null){const s=e.length;i=new Array(s);for(let r=0;r!==s;++r)i[r]=e[r].clone()}return this.clippingPlanes=i,this.clipIntersection=t.clipIntersection,this.clipShadows=t.clipShadows,this.shadowSide=t.shadowSide,this.colorWrite=t.colorWrite,this.precision=t.precision,this.polygonOffset=t.polygonOffset,this.polygonOffsetFactor=t.polygonOffsetFactor,this.polygonOffsetUnits=t.polygonOffsetUnits,this.dithering=t.dithering,this.alphaTest=t.alphaTest,this.alphaHash=t.alphaHash,this.alphaToCoverage=t.alphaToCoverage,this.premultipliedAlpha=t.premultipliedAlpha,this.forceSinglePass=t.forceSinglePass,this.visible=t.visible,this.toneMapped=t.toneMapped,this.userData=JSON.parse(JSON.stringify(t.userData)),this}dispose(){this.dispatchEvent({type:"dispose"})}set needsUpdate(t){t===!0&&this.version++}onBuild(){console.warn("Material: onBuild() has been removed.")}}class Yi extends Lr{static get type(){return"MeshBasicMaterial"}constructor(t){super(),this.isMeshBasicMaterial=!0,this.color=new $t(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new Gn,this.combine=Cc,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.lightMap=t.lightMap,this.lightMapIntensity=t.lightMapIntensity,this.aoMap=t.aoMap,this.aoMapIntensity=t.aoMapIntensity,this.specularMap=t.specularMap,this.alphaMap=t.alphaMap,this.envMap=t.envMap,this.envMapRotation.copy(t.envMapRotation),this.combine=t.combine,this.reflectivity=t.reflectivity,this.refractionRatio=t.refractionRatio,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.wireframeLinecap=t.wireframeLinecap,this.wireframeLinejoin=t.wireframeLinejoin,this.fog=t.fog,this}}const xe=new G,$r=new kt;class En{constructor(t,e,i=!1){if(Array.isArray(t))throw new TypeError("THREE.BufferAttribute: array should be a Typed Array.");this.isBufferAttribute=!0,this.name="",this.array=t,this.itemSize=e,this.count=t!==void 0?t.length/e:0,this.normalized=i,this.usage=Gu,this.updateRanges=[],this.gpuType=On,this.version=0}onUploadCallback(){}set needsUpdate(t){t===!0&&this.version++}setUsage(t){return this.usage=t,this}addUpdateRange(t,e){this.updateRanges.push({start:t,count:e})}clearUpdateRanges(){this.updateRanges.length=0}copy(t){return this.name=t.name,this.array=new t.array.constructor(t.array),this.itemSize=t.itemSize,this.count=t.count,this.normalized=t.normalized,this.usage=t.usage,this.gpuType=t.gpuType,this}copyAt(t,e,i){t*=this.itemSize,i*=e.itemSize;for(let s=0,r=this.itemSize;s<r;s++)this.array[t+s]=e.array[i+s];return this}copyArray(t){return this.array.set(t),this}applyMatrix3(t){if(this.itemSize===2)for(let e=0,i=this.count;e<i;e++)$r.fromBufferAttribute(this,e),$r.applyMatrix3(t),this.setXY(e,$r.x,$r.y);else if(this.itemSize===3)for(let e=0,i=this.count;e<i;e++)xe.fromBufferAttribute(this,e),xe.applyMatrix3(t),this.setXYZ(e,xe.x,xe.y,xe.z);return this}applyMatrix4(t){for(let e=0,i=this.count;e<i;e++)xe.fromBufferAttribute(this,e),xe.applyMatrix4(t),this.setXYZ(e,xe.x,xe.y,xe.z);return this}applyNormalMatrix(t){for(let e=0,i=this.count;e<i;e++)xe.fromBufferAttribute(this,e),xe.applyNormalMatrix(t),this.setXYZ(e,xe.x,xe.y,xe.z);return this}transformDirection(t){for(let e=0,i=this.count;e<i;e++)xe.fromBufferAttribute(this,e),xe.transformDirection(t),this.setXYZ(e,xe.x,xe.y,xe.z);return this}set(t,e=0){return this.array.set(t,e),this}getComponent(t,e){let i=this.array[t*this.itemSize+e];return this.normalized&&(i=js(i,this.array)),i}setComponent(t,e,i){return this.normalized&&(i=He(i,this.array)),this.array[t*this.itemSize+e]=i,this}getX(t){let e=this.array[t*this.itemSize];return this.normalized&&(e=js(e,this.array)),e}setX(t,e){return this.normalized&&(e=He(e,this.array)),this.array[t*this.itemSize]=e,this}getY(t){let e=this.array[t*this.itemSize+1];return this.normalized&&(e=js(e,this.array)),e}setY(t,e){return this.normalized&&(e=He(e,this.array)),this.array[t*this.itemSize+1]=e,this}getZ(t){let e=this.array[t*this.itemSize+2];return this.normalized&&(e=js(e,this.array)),e}setZ(t,e){return this.normalized&&(e=He(e,this.array)),this.array[t*this.itemSize+2]=e,this}getW(t){let e=this.array[t*this.itemSize+3];return this.normalized&&(e=js(e,this.array)),e}setW(t,e){return this.normalized&&(e=He(e,this.array)),this.array[t*this.itemSize+3]=e,this}setXY(t,e,i){return t*=this.itemSize,this.normalized&&(e=He(e,this.array),i=He(i,this.array)),this.array[t+0]=e,this.array[t+1]=i,this}setXYZ(t,e,i,s){return t*=this.itemSize,this.normalized&&(e=He(e,this.array),i=He(i,this.array),s=He(s,this.array)),this.array[t+0]=e,this.array[t+1]=i,this.array[t+2]=s,this}setXYZW(t,e,i,s,r){return t*=this.itemSize,this.normalized&&(e=He(e,this.array),i=He(i,this.array),s=He(s,this.array),r=He(r,this.array)),this.array[t+0]=e,this.array[t+1]=i,this.array[t+2]=s,this.array[t+3]=r,this}onUpload(t){return this.onUploadCallback=t,this}clone(){return new this.constructor(this.array,this.itemSize).copy(this)}toJSON(){const t={itemSize:this.itemSize,type:this.array.constructor.name,array:Array.from(this.array),normalized:this.normalized};return this.name!==""&&(t.name=this.name),this.usage!==Gu&&(t.usage=this.usage),t}}class Ud extends En{constructor(t,e,i){super(new Uint16Array(t),e,i)}}class Nd extends En{constructor(t,e,i){super(new Uint32Array(t),e,i)}}class Ie extends En{constructor(t,e,i){super(new Float32Array(t),e,i)}}let Xg=0;const tn=new ue,Va=new Ae,xs=new G,$e=new os,Js=new os,be=new G;class qn extends rs{constructor(){super(),this.isBufferGeometry=!0,Object.defineProperty(this,"id",{value:Xg++}),this.uuid=Pr(),this.name="",this.type="BufferGeometry",this.index=null,this.indirect=null,this.attributes={},this.morphAttributes={},this.morphTargetsRelative=!1,this.groups=[],this.boundingBox=null,this.boundingSphere=null,this.drawRange={start:0,count:1/0},this.userData={}}getIndex(){return this.index}setIndex(t){return Array.isArray(t)?this.index=new(Rd(t)?Nd:Ud)(t,1):this.index=t,this}setIndirect(t){return this.indirect=t,this}getIndirect(){return this.indirect}getAttribute(t){return this.attributes[t]}setAttribute(t,e){return this.attributes[t]=e,this}deleteAttribute(t){return delete this.attributes[t],this}hasAttribute(t){return this.attributes[t]!==void 0}addGroup(t,e,i=0){this.groups.push({start:t,count:e,materialIndex:i})}clearGroups(){this.groups=[]}setDrawRange(t,e){this.drawRange.start=t,this.drawRange.count=e}applyMatrix4(t){const e=this.attributes.position;e!==void 0&&(e.applyMatrix4(t),e.needsUpdate=!0);const i=this.attributes.normal;if(i!==void 0){const r=new Wt().getNormalMatrix(t);i.applyNormalMatrix(r),i.needsUpdate=!0}const s=this.attributes.tangent;return s!==void 0&&(s.transformDirection(t),s.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this}applyQuaternion(t){return tn.makeRotationFromQuaternion(t),this.applyMatrix4(tn),this}rotateX(t){return tn.makeRotationX(t),this.applyMatrix4(tn),this}rotateY(t){return tn.makeRotationY(t),this.applyMatrix4(tn),this}rotateZ(t){return tn.makeRotationZ(t),this.applyMatrix4(tn),this}translate(t,e,i){return tn.makeTranslation(t,e,i),this.applyMatrix4(tn),this}scale(t,e,i){return tn.makeScale(t,e,i),this.applyMatrix4(tn),this}lookAt(t){return Va.lookAt(t),Va.updateMatrix(),this.applyMatrix4(Va.matrix),this}center(){return this.computeBoundingBox(),this.boundingBox.getCenter(xs).negate(),this.translate(xs.x,xs.y,xs.z),this}setFromPoints(t){const e=this.getAttribute("position");if(e===void 0){const i=[];for(let s=0,r=t.length;s<r;s++){const o=t[s];i.push(o.x,o.y,o.z||0)}this.setAttribute("position",new Ie(i,3))}else{for(let i=0,s=e.count;i<s;i++){const r=t[i];e.setXYZ(i,r.x,r.y,r.z||0)}t.length>e.count&&console.warn("THREE.BufferGeometry: Buffer size too small for points data. Use .dispose() and create a new geometry."),e.needsUpdate=!0}return this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new os);const t=this.attributes.position,e=this.morphAttributes.position;if(t&&t.isGLBufferAttribute){console.error("THREE.BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box.",this),this.boundingBox.set(new G(-1/0,-1/0,-1/0),new G(1/0,1/0,1/0));return}if(t!==void 0){if(this.boundingBox.setFromBufferAttribute(t),e)for(let i=0,s=e.length;i<s;i++){const r=e[i];$e.setFromBufferAttribute(r),this.morphTargetsRelative?(be.addVectors(this.boundingBox.min,$e.min),this.boundingBox.expandByPoint(be),be.addVectors(this.boundingBox.max,$e.max),this.boundingBox.expandByPoint(be)):(this.boundingBox.expandByPoint($e.min),this.boundingBox.expandByPoint($e.max))}}else this.boundingBox.makeEmpty();(isNaN(this.boundingBox.min.x)||isNaN(this.boundingBox.min.y)||isNaN(this.boundingBox.min.z))&&console.error('THREE.BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.',this)}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new Dr);const t=this.attributes.position,e=this.morphAttributes.position;if(t&&t.isGLBufferAttribute){console.error("THREE.BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere.",this),this.boundingSphere.set(new G,1/0);return}if(t){const i=this.boundingSphere.center;if($e.setFromBufferAttribute(t),e)for(let r=0,o=e.length;r<o;r++){const a=e[r];Js.setFromBufferAttribute(a),this.morphTargetsRelative?(be.addVectors($e.min,Js.min),$e.expandByPoint(be),be.addVectors($e.max,Js.max),$e.expandByPoint(be)):($e.expandByPoint(Js.min),$e.expandByPoint(Js.max))}$e.getCenter(i);let s=0;for(let r=0,o=t.count;r<o;r++)be.fromBufferAttribute(t,r),s=Math.max(s,i.distanceToSquared(be));if(e)for(let r=0,o=e.length;r<o;r++){const a=e[r],l=this.morphTargetsRelative;for(let u=0,c=a.count;u<c;u++)be.fromBufferAttribute(a,u),l&&(xs.fromBufferAttribute(t,u),be.add(xs)),s=Math.max(s,i.distanceToSquared(be))}this.boundingSphere.radius=Math.sqrt(s),isNaN(this.boundingSphere.radius)&&console.error('THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',this)}}computeTangents(){const t=this.index,e=this.attributes;if(t===null||e.position===void 0||e.normal===void 0||e.uv===void 0){console.error("THREE.BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");return}const i=e.position,s=e.normal,r=e.uv;this.hasAttribute("tangent")===!1&&this.setAttribute("tangent",new En(new Float32Array(4*i.count),4));const o=this.getAttribute("tangent"),a=[],l=[];for(let N=0;N<i.count;N++)a[N]=new G,l[N]=new G;const u=new G,c=new G,h=new G,d=new kt,p=new kt,g=new kt,v=new G,m=new G;function f(N,E,M){u.fromBufferAttribute(i,N),c.fromBufferAttribute(i,E),h.fromBufferAttribute(i,M),d.fromBufferAttribute(r,N),p.fromBufferAttribute(r,E),g.fromBufferAttribute(r,M),c.sub(u),h.sub(u),p.sub(d),g.sub(d);const L=1/(p.x*g.y-g.x*p.y);isFinite(L)&&(v.copy(c).multiplyScalar(g.y).addScaledVector(h,-p.y).multiplyScalar(L),m.copy(h).multiplyScalar(p.x).addScaledVector(c,-g.x).multiplyScalar(L),a[N].add(v),a[E].add(v),a[M].add(v),l[N].add(m),l[E].add(m),l[M].add(m))}let w=this.groups;w.length===0&&(w=[{start:0,count:t.count}]);for(let N=0,E=w.length;N<E;++N){const M=w[N],L=M.start,J=M.count;for(let C=L,k=L+J;C<k;C+=3)f(t.getX(C+0),t.getX(C+1),t.getX(C+2))}const b=new G,x=new G,B=new G,P=new G;function D(N){B.fromBufferAttribute(s,N),P.copy(B);const E=a[N];b.copy(E),b.sub(B.multiplyScalar(B.dot(E))).normalize(),x.crossVectors(P,E);const L=x.dot(l[N])<0?-1:1;o.setXYZW(N,b.x,b.y,b.z,L)}for(let N=0,E=w.length;N<E;++N){const M=w[N],L=M.start,J=M.count;for(let C=L,k=L+J;C<k;C+=3)D(t.getX(C+0)),D(t.getX(C+1)),D(t.getX(C+2))}}computeVertexNormals(){const t=this.index,e=this.getAttribute("position");if(e!==void 0){let i=this.getAttribute("normal");if(i===void 0)i=new En(new Float32Array(e.count*3),3),this.setAttribute("normal",i);else for(let d=0,p=i.count;d<p;d++)i.setXYZ(d,0,0,0);const s=new G,r=new G,o=new G,a=new G,l=new G,u=new G,c=new G,h=new G;if(t)for(let d=0,p=t.count;d<p;d+=3){const g=t.getX(d+0),v=t.getX(d+1),m=t.getX(d+2);s.fromBufferAttribute(e,g),r.fromBufferAttribute(e,v),o.fromBufferAttribute(e,m),c.subVectors(o,r),h.subVectors(s,r),c.cross(h),a.fromBufferAttribute(i,g),l.fromBufferAttribute(i,v),u.fromBufferAttribute(i,m),a.add(c),l.add(c),u.add(c),i.setXYZ(g,a.x,a.y,a.z),i.setXYZ(v,l.x,l.y,l.z),i.setXYZ(m,u.x,u.y,u.z)}else for(let d=0,p=e.count;d<p;d+=3)s.fromBufferAttribute(e,d+0),r.fromBufferAttribute(e,d+1),o.fromBufferAttribute(e,d+2),c.subVectors(o,r),h.subVectors(s,r),c.cross(h),i.setXYZ(d+0,c.x,c.y,c.z),i.setXYZ(d+1,c.x,c.y,c.z),i.setXYZ(d+2,c.x,c.y,c.z);this.normalizeNormals(),i.needsUpdate=!0}}normalizeNormals(){const t=this.attributes.normal;for(let e=0,i=t.count;e<i;e++)be.fromBufferAttribute(t,e),be.normalize(),t.setXYZ(e,be.x,be.y,be.z)}toNonIndexed(){function t(a,l){const u=a.array,c=a.itemSize,h=a.normalized,d=new u.constructor(l.length*c);let p=0,g=0;for(let v=0,m=l.length;v<m;v++){a.isInterleavedBufferAttribute?p=l[v]*a.data.stride+a.offset:p=l[v]*c;for(let f=0;f<c;f++)d[g++]=u[p++]}return new En(d,c,h)}if(this.index===null)return console.warn("THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."),this;const e=new qn,i=this.index.array,s=this.attributes;for(const a in s){const l=s[a],u=t(l,i);e.setAttribute(a,u)}const r=this.morphAttributes;for(const a in r){const l=[],u=r[a];for(let c=0,h=u.length;c<h;c++){const d=u[c],p=t(d,i);l.push(p)}e.morphAttributes[a]=l}e.morphTargetsRelative=this.morphTargetsRelative;const o=this.groups;for(let a=0,l=o.length;a<l;a++){const u=o[a];e.addGroup(u.start,u.count,u.materialIndex)}return e}toJSON(){const t={metadata:{version:4.6,type:"BufferGeometry",generator:"BufferGeometry.toJSON"}};if(t.uuid=this.uuid,t.type=this.type,this.name!==""&&(t.name=this.name),Object.keys(this.userData).length>0&&(t.userData=this.userData),this.parameters!==void 0){const l=this.parameters;for(const u in l)l[u]!==void 0&&(t[u]=l[u]);return t}t.data={attributes:{}};const e=this.index;e!==null&&(t.data.index={type:e.array.constructor.name,array:Array.prototype.slice.call(e.array)});const i=this.attributes;for(const l in i){const u=i[l];t.data.attributes[l]=u.toJSON(t.data)}const s={};let r=!1;for(const l in this.morphAttributes){const u=this.morphAttributes[l],c=[];for(let h=0,d=u.length;h<d;h++){const p=u[h];c.push(p.toJSON(t.data))}c.length>0&&(s[l]=c,r=!0)}r&&(t.data.morphAttributes=s,t.data.morphTargetsRelative=this.morphTargetsRelative);const o=this.groups;o.length>0&&(t.data.groups=JSON.parse(JSON.stringify(o)));const a=this.boundingSphere;return a!==null&&(t.data.boundingSphere={center:a.center.toArray(),radius:a.radius}),t}clone(){return new this.constructor().copy(this)}copy(t){this.index=null,this.attributes={},this.morphAttributes={},this.groups=[],this.boundingBox=null,this.boundingSphere=null;const e={};this.name=t.name;const i=t.index;i!==null&&this.setIndex(i.clone(e));const s=t.attributes;for(const u in s){const c=s[u];this.setAttribute(u,c.clone(e))}const r=t.morphAttributes;for(const u in r){const c=[],h=r[u];for(let d=0,p=h.length;d<p;d++)c.push(h[d].clone(e));this.morphAttributes[u]=c}this.morphTargetsRelative=t.morphTargetsRelative;const o=t.groups;for(let u=0,c=o.length;u<c;u++){const h=o[u];this.addGroup(h.start,h.count,h.materialIndex)}const a=t.boundingBox;a!==null&&(this.boundingBox=a.clone());const l=t.boundingSphere;return l!==null&&(this.boundingSphere=l.clone()),this.drawRange.start=t.drawRange.start,this.drawRange.count=t.drawRange.count,this.userData=t.userData,this}dispose(){this.dispatchEvent({type:"dispose"})}}const oh=new ue,zi=new Dd,Zr=new Dr,ah=new G,Jr=new G,Qr=new G,to=new G,Ga=new G,eo=new G,lh=new G,no=new G;class qe extends Ae{constructor(t=new qn,e=new Yi){super(),this.isMesh=!0,this.type="Mesh",this.geometry=t,this.material=e,this.updateMorphTargets()}copy(t,e){return super.copy(t,e),t.morphTargetInfluences!==void 0&&(this.morphTargetInfluences=t.morphTargetInfluences.slice()),t.morphTargetDictionary!==void 0&&(this.morphTargetDictionary=Object.assign({},t.morphTargetDictionary)),this.material=Array.isArray(t.material)?t.material.slice():t.material,this.geometry=t.geometry,this}updateMorphTargets(){const e=this.geometry.morphAttributes,i=Object.keys(e);if(i.length>0){const s=e[i[0]];if(s!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let r=0,o=s.length;r<o;r++){const a=s[r].name||String(r);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=r}}}}getVertexPosition(t,e){const i=this.geometry,s=i.attributes.position,r=i.morphAttributes.position,o=i.morphTargetsRelative;e.fromBufferAttribute(s,t);const a=this.morphTargetInfluences;if(r&&a){eo.set(0,0,0);for(let l=0,u=r.length;l<u;l++){const c=a[l],h=r[l];c!==0&&(Ga.fromBufferAttribute(h,t),o?eo.addScaledVector(Ga,c):eo.addScaledVector(Ga.sub(e),c))}e.add(eo)}return e}raycast(t,e){const i=this.geometry,s=this.material,r=this.matrixWorld;s!==void 0&&(i.boundingSphere===null&&i.computeBoundingSphere(),Zr.copy(i.boundingSphere),Zr.applyMatrix4(r),zi.copy(t.ray).recast(t.near),!(Zr.containsPoint(zi.origin)===!1&&(zi.intersectSphere(Zr,ah)===null||zi.origin.distanceToSquared(ah)>(t.far-t.near)**2))&&(oh.copy(r).invert(),zi.copy(t.ray).applyMatrix4(oh),!(i.boundingBox!==null&&zi.intersectsBox(i.boundingBox)===!1)&&this._computeIntersections(t,e,zi)))}_computeIntersections(t,e,i){let s;const r=this.geometry,o=this.material,a=r.index,l=r.attributes.position,u=r.attributes.uv,c=r.attributes.uv1,h=r.attributes.normal,d=r.groups,p=r.drawRange;if(a!==null)if(Array.isArray(o))for(let g=0,v=d.length;g<v;g++){const m=d[g],f=o[m.materialIndex],w=Math.max(m.start,p.start),b=Math.min(a.count,Math.min(m.start+m.count,p.start+p.count));for(let x=w,B=b;x<B;x+=3){const P=a.getX(x),D=a.getX(x+1),N=a.getX(x+2);s=io(this,f,t,i,u,c,h,P,D,N),s&&(s.faceIndex=Math.floor(x/3),s.face.materialIndex=m.materialIndex,e.push(s))}}else{const g=Math.max(0,p.start),v=Math.min(a.count,p.start+p.count);for(let m=g,f=v;m<f;m+=3){const w=a.getX(m),b=a.getX(m+1),x=a.getX(m+2);s=io(this,o,t,i,u,c,h,w,b,x),s&&(s.faceIndex=Math.floor(m/3),e.push(s))}}else if(l!==void 0)if(Array.isArray(o))for(let g=0,v=d.length;g<v;g++){const m=d[g],f=o[m.materialIndex],w=Math.max(m.start,p.start),b=Math.min(l.count,Math.min(m.start+m.count,p.start+p.count));for(let x=w,B=b;x<B;x+=3){const P=x,D=x+1,N=x+2;s=io(this,f,t,i,u,c,h,P,D,N),s&&(s.faceIndex=Math.floor(x/3),s.face.materialIndex=m.materialIndex,e.push(s))}}else{const g=Math.max(0,p.start),v=Math.min(l.count,p.start+p.count);for(let m=g,f=v;m<f;m+=3){const w=m,b=m+1,x=m+2;s=io(this,o,t,i,u,c,h,w,b,x),s&&(s.faceIndex=Math.floor(m/3),e.push(s))}}}}function qg(n,t,e,i,s,r,o,a){let l;if(t.side===Ye?l=i.intersectTriangle(o,r,s,!0,a):l=i.intersectTriangle(s,r,o,t.side===Pi,a),l===null)return null;no.copy(a),no.applyMatrix4(n.matrixWorld);const u=e.ray.origin.distanceTo(no);return u<e.near||u>e.far?null:{distance:u,point:no.clone(),object:n}}function io(n,t,e,i,s,r,o,a,l,u){n.getVertexPosition(a,Jr),n.getVertexPosition(l,Qr),n.getVertexPosition(u,to);const c=qg(n,t,e,i,Jr,Qr,to,lh);if(c){const h=new G;xn.getBarycoord(lh,Jr,Qr,to,h),s&&(c.uv=xn.getInterpolatedAttribute(s,a,l,u,h,new kt)),r&&(c.uv1=xn.getInterpolatedAttribute(r,a,l,u,h,new kt)),o&&(c.normal=xn.getInterpolatedAttribute(o,a,l,u,h,new G),c.normal.dot(i.direction)>0&&c.normal.multiplyScalar(-1));const d={a,b:l,c:u,normal:new G,materialIndex:0};xn.getNormal(Jr,Qr,to,d.normal),c.face=d,c.barycoord=h}return c}class is extends qn{constructor(t=1,e=1,i=1,s=1,r=1,o=1){super(),this.type="BoxGeometry",this.parameters={width:t,height:e,depth:i,widthSegments:s,heightSegments:r,depthSegments:o};const a=this;s=Math.floor(s),r=Math.floor(r),o=Math.floor(o);const l=[],u=[],c=[],h=[];let d=0,p=0;g("z","y","x",-1,-1,i,e,t,o,r,0),g("z","y","x",1,-1,i,e,-t,o,r,1),g("x","z","y",1,1,t,i,e,s,o,2),g("x","z","y",1,-1,t,i,-e,s,o,3),g("x","y","z",1,-1,t,e,i,s,r,4),g("x","y","z",-1,-1,t,e,-i,s,r,5),this.setIndex(l),this.setAttribute("position",new Ie(u,3)),this.setAttribute("normal",new Ie(c,3)),this.setAttribute("uv",new Ie(h,2));function g(v,m,f,w,b,x,B,P,D,N,E){const M=x/D,L=B/N,J=x/2,C=B/2,k=P/2,Y=D+1,H=N+1;let q=0,z=0;const at=new G;for(let dt=0;dt<H;dt++){const bt=dt*L-C;for(let Ut=0;Ut<Y;Ut++){const ee=Ut*M-J;at[v]=ee*w,at[m]=bt*b,at[f]=k,u.push(at.x,at.y,at.z),at[v]=0,at[m]=0,at[f]=P>0?1:-1,c.push(at.x,at.y,at.z),h.push(Ut/D),h.push(1-dt/N),q+=1}}for(let dt=0;dt<N;dt++)for(let bt=0;bt<D;bt++){const Ut=d+bt+Y*dt,ee=d+bt+Y*(dt+1),it=d+(bt+1)+Y*(dt+1),ut=d+(bt+1)+Y*dt;l.push(Ut,ee,ut),l.push(ee,it,ut),z+=6}a.addGroup(p,z,E),p+=z,d+=q}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new is(t.width,t.height,t.depth,t.widthSegments,t.heightSegments,t.depthSegments)}}function ks(n){const t={};for(const e in n){t[e]={};for(const i in n[e]){const s=n[e][i];s&&(s.isColor||s.isMatrix3||s.isMatrix4||s.isVector2||s.isVector3||s.isVector4||s.isTexture||s.isQuaternion)?s.isRenderTargetTexture?(console.warn("UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms()."),t[e][i]=null):t[e][i]=s.clone():Array.isArray(s)?t[e][i]=s.slice():t[e][i]=s}}return t}function Ne(n){const t={};for(let e=0;e<n.length;e++){const i=ks(n[e]);for(const s in i)t[s]=i[s]}return t}function Yg(n){const t=[];for(let e=0;e<n.length;e++)t.push(n[e].clone());return t}function Od(n){const t=n.getRenderTarget();return t===null?n.outputColorSpace:t.isXRRenderTarget===!0?t.texture.colorSpace:Jt.workingColorSpace}const jg={clone:ks,merge:Ne};var Kg=`void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,$g=`void main() {
	gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
}`;class Li extends Lr{static get type(){return"ShaderMaterial"}constructor(t){super(),this.isShaderMaterial=!0,this.defines={},this.uniforms={},this.uniformsGroups=[],this.vertexShader=Kg,this.fragmentShader=$g,this.linewidth=1,this.wireframe=!1,this.wireframeLinewidth=1,this.fog=!1,this.lights=!1,this.clipping=!1,this.forceSinglePass=!0,this.extensions={clipCullDistance:!1,multiDraw:!1},this.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv1:[0,0]},this.index0AttributeName=void 0,this.uniformsNeedUpdate=!1,this.glslVersion=null,t!==void 0&&this.setValues(t)}copy(t){return super.copy(t),this.fragmentShader=t.fragmentShader,this.vertexShader=t.vertexShader,this.uniforms=ks(t.uniforms),this.uniformsGroups=Yg(t.uniformsGroups),this.defines=Object.assign({},t.defines),this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.fog=t.fog,this.lights=t.lights,this.clipping=t.clipping,this.extensions=Object.assign({},t.extensions),this.glslVersion=t.glslVersion,this}toJSON(t){const e=super.toJSON(t);e.glslVersion=this.glslVersion,e.uniforms={};for(const s in this.uniforms){const o=this.uniforms[s].value;o&&o.isTexture?e.uniforms[s]={type:"t",value:o.toJSON(t).uuid}:o&&o.isColor?e.uniforms[s]={type:"c",value:o.getHex()}:o&&o.isVector2?e.uniforms[s]={type:"v2",value:o.toArray()}:o&&o.isVector3?e.uniforms[s]={type:"v3",value:o.toArray()}:o&&o.isVector4?e.uniforms[s]={type:"v4",value:o.toArray()}:o&&o.isMatrix3?e.uniforms[s]={type:"m3",value:o.toArray()}:o&&o.isMatrix4?e.uniforms[s]={type:"m4",value:o.toArray()}:e.uniforms[s]={value:o}}Object.keys(this.defines).length>0&&(e.defines=this.defines),e.vertexShader=this.vertexShader,e.fragmentShader=this.fragmentShader,e.lights=this.lights,e.clipping=this.clipping;const i={};for(const s in this.extensions)this.extensions[s]===!0&&(i[s]=!0);return Object.keys(i).length>0&&(e.extensions=i),e}}class Fd extends Ae{constructor(){super(),this.isCamera=!0,this.type="Camera",this.matrixWorldInverse=new ue,this.projectionMatrix=new ue,this.projectionMatrixInverse=new ue,this.coordinateSystem=oi}copy(t,e){return super.copy(t,e),this.matrixWorldInverse.copy(t.matrixWorldInverse),this.projectionMatrix.copy(t.projectionMatrix),this.projectionMatrixInverse.copy(t.projectionMatrixInverse),this.coordinateSystem=t.coordinateSystem,this}getWorldDirection(t){return super.getWorldDirection(t).negate()}updateMatrixWorld(t){super.updateMatrixWorld(t),this.matrixWorldInverse.copy(this.matrixWorld).invert()}updateWorldMatrix(t,e){super.updateWorldMatrix(t,e),this.matrixWorldInverse.copy(this.matrixWorld).invert()}clone(){return new this.constructor().copy(this)}}const xi=new G,ch=new kt,uh=new kt;class on extends Fd{constructor(t=50,e=1,i=.1,s=2e3){super(),this.isPerspectiveCamera=!0,this.type="PerspectiveCamera",this.fov=t,this.zoom=1,this.near=i,this.far=s,this.focus=10,this.aspect=e,this.view=null,this.filmGauge=35,this.filmOffset=0,this.updateProjectionMatrix()}copy(t,e){return super.copy(t,e),this.fov=t.fov,this.zoom=t.zoom,this.near=t.near,this.far=t.far,this.focus=t.focus,this.aspect=t.aspect,this.view=t.view===null?null:Object.assign({},t.view),this.filmGauge=t.filmGauge,this.filmOffset=t.filmOffset,this}setFocalLength(t){const e=.5*this.getFilmHeight()/t;this.fov=ec*2*Math.atan(e),this.updateProjectionMatrix()}getFocalLength(){const t=Math.tan(So*.5*this.fov);return .5*this.getFilmHeight()/t}getEffectiveFOV(){return ec*2*Math.atan(Math.tan(So*.5*this.fov)/this.zoom)}getFilmWidth(){return this.filmGauge*Math.min(this.aspect,1)}getFilmHeight(){return this.filmGauge/Math.max(this.aspect,1)}getViewBounds(t,e,i){xi.set(-1,-1,.5).applyMatrix4(this.projectionMatrixInverse),e.set(xi.x,xi.y).multiplyScalar(-t/xi.z),xi.set(1,1,.5).applyMatrix4(this.projectionMatrixInverse),i.set(xi.x,xi.y).multiplyScalar(-t/xi.z)}getViewSize(t,e){return this.getViewBounds(t,ch,uh),e.subVectors(uh,ch)}setViewOffset(t,e,i,s,r,o){this.aspect=t/e,this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=t,this.view.fullHeight=e,this.view.offsetX=i,this.view.offsetY=s,this.view.width=r,this.view.height=o,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){const t=this.near;let e=t*Math.tan(So*.5*this.fov)/this.zoom,i=2*e,s=this.aspect*i,r=-.5*s;const o=this.view;if(this.view!==null&&this.view.enabled){const l=o.fullWidth,u=o.fullHeight;r+=o.offsetX*s/l,e-=o.offsetY*i/u,s*=o.width/l,i*=o.height/u}const a=this.filmOffset;a!==0&&(r+=t*a/this.getFilmWidth()),this.projectionMatrix.makePerspective(r,r+s,e,e-i,t,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(t){const e=super.toJSON(t);return e.object.fov=this.fov,e.object.zoom=this.zoom,e.object.near=this.near,e.object.far=this.far,e.object.focus=this.focus,e.object.aspect=this.aspect,this.view!==null&&(e.object.view=Object.assign({},this.view)),e.object.filmGauge=this.filmGauge,e.object.filmOffset=this.filmOffset,e}}const ys=-90,Ms=1;class Zg extends Ae{constructor(t,e,i){super(),this.type="CubeCamera",this.renderTarget=i,this.coordinateSystem=null,this.activeMipmapLevel=0;const s=new on(ys,Ms,t,e);s.layers=this.layers,this.add(s);const r=new on(ys,Ms,t,e);r.layers=this.layers,this.add(r);const o=new on(ys,Ms,t,e);o.layers=this.layers,this.add(o);const a=new on(ys,Ms,t,e);a.layers=this.layers,this.add(a);const l=new on(ys,Ms,t,e);l.layers=this.layers,this.add(l);const u=new on(ys,Ms,t,e);u.layers=this.layers,this.add(u)}updateCoordinateSystem(){const t=this.coordinateSystem,e=this.children.concat(),[i,s,r,o,a,l]=e;for(const u of e)this.remove(u);if(t===oi)i.up.set(0,1,0),i.lookAt(1,0,0),s.up.set(0,1,0),s.lookAt(-1,0,0),r.up.set(0,0,-1),r.lookAt(0,1,0),o.up.set(0,0,1),o.lookAt(0,-1,0),a.up.set(0,1,0),a.lookAt(0,0,1),l.up.set(0,1,0),l.lookAt(0,0,-1);else if(t===Bo)i.up.set(0,-1,0),i.lookAt(-1,0,0),s.up.set(0,-1,0),s.lookAt(1,0,0),r.up.set(0,0,1),r.lookAt(0,1,0),o.up.set(0,0,-1),o.lookAt(0,-1,0),a.up.set(0,-1,0),a.lookAt(0,0,1),l.up.set(0,-1,0),l.lookAt(0,0,-1);else throw new Error("THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: "+t);for(const u of e)this.add(u),u.updateMatrixWorld()}update(t,e){this.parent===null&&this.updateMatrixWorld();const{renderTarget:i,activeMipmapLevel:s}=this;this.coordinateSystem!==t.coordinateSystem&&(this.coordinateSystem=t.coordinateSystem,this.updateCoordinateSystem());const[r,o,a,l,u,c]=this.children,h=t.getRenderTarget(),d=t.getActiveCubeFace(),p=t.getActiveMipmapLevel(),g=t.xr.enabled;t.xr.enabled=!1;const v=i.texture.generateMipmaps;i.texture.generateMipmaps=!1,t.setRenderTarget(i,0,s),t.render(e,r),t.setRenderTarget(i,1,s),t.render(e,o),t.setRenderTarget(i,2,s),t.render(e,a),t.setRenderTarget(i,3,s),t.render(e,l),t.setRenderTarget(i,4,s),t.render(e,u),i.texture.generateMipmaps=v,t.setRenderTarget(i,5,s),t.render(e,c),t.setRenderTarget(h,d,p),t.xr.enabled=g,i.texture.needsPMREMUpdate=!0}}class Bd extends ze{constructor(t,e,i,s,r,o,a,l,u,c){t=t!==void 0?t:[],e=e!==void 0?e:Os,super(t,e,i,s,r,o,a,l,u,c),this.isCubeTexture=!0,this.flipY=!1}get images(){return this.image}set images(t){this.image=t}}class Jg extends ns{constructor(t=1,e={}){super(t,t,e),this.isWebGLCubeRenderTarget=!0;const i={width:t,height:t,depth:1},s=[i,i,i,i,i,i];this.texture=new Bd(s,e.mapping,e.wrapS,e.wrapT,e.magFilter,e.minFilter,e.format,e.type,e.anisotropy,e.colorSpace),this.texture.isRenderTargetTexture=!0,this.texture.generateMipmaps=e.generateMipmaps!==void 0?e.generateMipmaps:!1,this.texture.minFilter=e.minFilter!==void 0?e.minFilter:Nn}fromEquirectangularTexture(t,e){this.texture.type=e.type,this.texture.colorSpace=e.colorSpace,this.texture.generateMipmaps=e.generateMipmaps,this.texture.minFilter=e.minFilter,this.texture.magFilter=e.magFilter;const i={uniforms:{tEquirect:{value:null}},vertexShader:`

				varying vec3 vWorldDirection;

				vec3 transformDirection( in vec3 dir, in mat4 matrix ) {

					return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );

				}

				void main() {

					vWorldDirection = transformDirection( position, modelMatrix );

					#include <begin_vertex>
					#include <project_vertex>

				}
			`,fragmentShader:`

				uniform sampler2D tEquirect;

				varying vec3 vWorldDirection;

				#include <common>

				void main() {

					vec3 direction = normalize( vWorldDirection );

					vec2 sampleUV = equirectUv( direction );

					gl_FragColor = texture2D( tEquirect, sampleUV );

				}
			`},s=new is(5,5,5),r=new Li({name:"CubemapFromEquirect",uniforms:ks(i.uniforms),vertexShader:i.vertexShader,fragmentShader:i.fragmentShader,side:Ye,blending:wi});r.uniforms.tEquirect.value=e;const o=new qe(s,r),a=e.minFilter;return e.minFilter===Zi&&(e.minFilter=Nn),new Zg(1,10,this).update(t,o),e.minFilter=a,o.geometry.dispose(),o.material.dispose(),this}clear(t,e,i,s){const r=t.getRenderTarget();for(let o=0;o<6;o++)t.setRenderTarget(this,o),t.clear(e,i,s);t.setRenderTarget(r)}}const Wa=new G,Qg=new G,tv=new Wt;class Mi{constructor(t=new G(1,0,0),e=0){this.isPlane=!0,this.normal=t,this.constant=e}set(t,e){return this.normal.copy(t),this.constant=e,this}setComponents(t,e,i,s){return this.normal.set(t,e,i),this.constant=s,this}setFromNormalAndCoplanarPoint(t,e){return this.normal.copy(t),this.constant=-e.dot(this.normal),this}setFromCoplanarPoints(t,e,i){const s=Wa.subVectors(i,e).cross(Qg.subVectors(t,e)).normalize();return this.setFromNormalAndCoplanarPoint(s,t),this}copy(t){return this.normal.copy(t.normal),this.constant=t.constant,this}normalize(){const t=1/this.normal.length();return this.normal.multiplyScalar(t),this.constant*=t,this}negate(){return this.constant*=-1,this.normal.negate(),this}distanceToPoint(t){return this.normal.dot(t)+this.constant}distanceToSphere(t){return this.distanceToPoint(t.center)-t.radius}projectPoint(t,e){return e.copy(t).addScaledVector(this.normal,-this.distanceToPoint(t))}intersectLine(t,e){const i=t.delta(Wa),s=this.normal.dot(i);if(s===0)return this.distanceToPoint(t.start)===0?e.copy(t.start):null;const r=-(t.start.dot(this.normal)+this.constant)/s;return r<0||r>1?null:e.copy(t.start).addScaledVector(i,r)}intersectsLine(t){const e=this.distanceToPoint(t.start),i=this.distanceToPoint(t.end);return e<0&&i>0||i<0&&e>0}intersectsBox(t){return t.intersectsPlane(this)}intersectsSphere(t){return t.intersectsPlane(this)}coplanarPoint(t){return t.copy(this.normal).multiplyScalar(-this.constant)}applyMatrix4(t,e){const i=e||tv.getNormalMatrix(t),s=this.coplanarPoint(Wa).applyMatrix4(t),r=this.normal.applyMatrix3(i).normalize();return this.constant=-s.dot(r),this}translate(t){return this.constant-=t.dot(this.normal),this}equals(t){return t.normal.equals(this.normal)&&t.constant===this.constant}clone(){return new this.constructor().copy(this)}}const ki=new Dr,so=new G;class Fc{constructor(t=new Mi,e=new Mi,i=new Mi,s=new Mi,r=new Mi,o=new Mi){this.planes=[t,e,i,s,r,o]}set(t,e,i,s,r,o){const a=this.planes;return a[0].copy(t),a[1].copy(e),a[2].copy(i),a[3].copy(s),a[4].copy(r),a[5].copy(o),this}copy(t){const e=this.planes;for(let i=0;i<6;i++)e[i].copy(t.planes[i]);return this}setFromProjectionMatrix(t,e=oi){const i=this.planes,s=t.elements,r=s[0],o=s[1],a=s[2],l=s[3],u=s[4],c=s[5],h=s[6],d=s[7],p=s[8],g=s[9],v=s[10],m=s[11],f=s[12],w=s[13],b=s[14],x=s[15];if(i[0].setComponents(l-r,d-u,m-p,x-f).normalize(),i[1].setComponents(l+r,d+u,m+p,x+f).normalize(),i[2].setComponents(l+o,d+c,m+g,x+w).normalize(),i[3].setComponents(l-o,d-c,m-g,x-w).normalize(),i[4].setComponents(l-a,d-h,m-v,x-b).normalize(),e===oi)i[5].setComponents(l+a,d+h,m+v,x+b).normalize();else if(e===Bo)i[5].setComponents(a,h,v,b).normalize();else throw new Error("THREE.Frustum.setFromProjectionMatrix(): Invalid coordinate system: "+e);return this}intersectsObject(t){if(t.boundingSphere!==void 0)t.boundingSphere===null&&t.computeBoundingSphere(),ki.copy(t.boundingSphere).applyMatrix4(t.matrixWorld);else{const e=t.geometry;e.boundingSphere===null&&e.computeBoundingSphere(),ki.copy(e.boundingSphere).applyMatrix4(t.matrixWorld)}return this.intersectsSphere(ki)}intersectsSprite(t){return ki.center.set(0,0,0),ki.radius=.7071067811865476,ki.applyMatrix4(t.matrixWorld),this.intersectsSphere(ki)}intersectsSphere(t){const e=this.planes,i=t.center,s=-t.radius;for(let r=0;r<6;r++)if(e[r].distanceToPoint(i)<s)return!1;return!0}intersectsBox(t){const e=this.planes;for(let i=0;i<6;i++){const s=e[i];if(so.x=s.normal.x>0?t.max.x:t.min.x,so.y=s.normal.y>0?t.max.y:t.min.y,so.z=s.normal.z>0?t.max.z:t.min.z,s.distanceToPoint(so)<0)return!1}return!0}containsPoint(t){const e=this.planes;for(let i=0;i<6;i++)if(e[i].distanceToPoint(t)<0)return!1;return!0}clone(){return new this.constructor().copy(this)}}function zd(){let n=null,t=!1,e=null,i=null;function s(r,o){e(r,o),i=n.requestAnimationFrame(s)}return{start:function(){t!==!0&&e!==null&&(i=n.requestAnimationFrame(s),t=!0)},stop:function(){n.cancelAnimationFrame(i),t=!1},setAnimationLoop:function(r){e=r},setContext:function(r){n=r}}}function ev(n){const t=new WeakMap;function e(a,l){const u=a.array,c=a.usage,h=u.byteLength,d=n.createBuffer();n.bindBuffer(l,d),n.bufferData(l,u,c),a.onUploadCallback();let p;if(u instanceof Float32Array)p=n.FLOAT;else if(u instanceof Uint16Array)a.isFloat16BufferAttribute?p=n.HALF_FLOAT:p=n.UNSIGNED_SHORT;else if(u instanceof Int16Array)p=n.SHORT;else if(u instanceof Uint32Array)p=n.UNSIGNED_INT;else if(u instanceof Int32Array)p=n.INT;else if(u instanceof Int8Array)p=n.BYTE;else if(u instanceof Uint8Array)p=n.UNSIGNED_BYTE;else if(u instanceof Uint8ClampedArray)p=n.UNSIGNED_BYTE;else throw new Error("THREE.WebGLAttributes: Unsupported buffer data format: "+u);return{buffer:d,type:p,bytesPerElement:u.BYTES_PER_ELEMENT,version:a.version,size:h}}function i(a,l,u){const c=l.array,h=l.updateRanges;if(n.bindBuffer(u,a),h.length===0)n.bufferSubData(u,0,c);else{h.sort((p,g)=>p.start-g.start);let d=0;for(let p=1;p<h.length;p++){const g=h[d],v=h[p];v.start<=g.start+g.count+1?g.count=Math.max(g.count,v.start+v.count-g.start):(++d,h[d]=v)}h.length=d+1;for(let p=0,g=h.length;p<g;p++){const v=h[p];n.bufferSubData(u,v.start*c.BYTES_PER_ELEMENT,c,v.start,v.count)}l.clearUpdateRanges()}l.onUploadCallback()}function s(a){return a.isInterleavedBufferAttribute&&(a=a.data),t.get(a)}function r(a){a.isInterleavedBufferAttribute&&(a=a.data);const l=t.get(a);l&&(n.deleteBuffer(l.buffer),t.delete(a))}function o(a,l){if(a.isInterleavedBufferAttribute&&(a=a.data),a.isGLBufferAttribute){const c=t.get(a);(!c||c.version<a.version)&&t.set(a,{buffer:a.buffer,type:a.type,bytesPerElement:a.elementSize,version:a.version});return}const u=t.get(a);if(u===void 0)t.set(a,e(a,l));else if(u.version<a.version){if(u.size!==a.array.byteLength)throw new Error("THREE.WebGLAttributes: The size of the buffer attribute's array buffer does not match the original size. Resizing buffer attributes is not supported.");i(u.buffer,a,l),u.version=a.version}}return{get:s,remove:r,update:o}}class sa extends qn{constructor(t=1,e=1,i=1,s=1){super(),this.type="PlaneGeometry",this.parameters={width:t,height:e,widthSegments:i,heightSegments:s};const r=t/2,o=e/2,a=Math.floor(i),l=Math.floor(s),u=a+1,c=l+1,h=t/a,d=e/l,p=[],g=[],v=[],m=[];for(let f=0;f<c;f++){const w=f*d-o;for(let b=0;b<u;b++){const x=b*h-r;g.push(x,-w,0),v.push(0,0,1),m.push(b/a),m.push(1-f/l)}}for(let f=0;f<l;f++)for(let w=0;w<a;w++){const b=w+u*f,x=w+u*(f+1),B=w+1+u*(f+1),P=w+1+u*f;p.push(b,x,P),p.push(x,B,P)}this.setIndex(p),this.setAttribute("position",new Ie(g,3)),this.setAttribute("normal",new Ie(v,3)),this.setAttribute("uv",new Ie(m,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new sa(t.width,t.height,t.widthSegments,t.heightSegments)}}var nv=`#ifdef USE_ALPHAHASH
	if ( diffuseColor.a < getAlphaHashThreshold( vPosition ) ) discard;
#endif`,iv=`#ifdef USE_ALPHAHASH
	const float ALPHA_HASH_SCALE = 0.05;
	float hash2D( vec2 value ) {
		return fract( 1.0e4 * sin( 17.0 * value.x + 0.1 * value.y ) * ( 0.1 + abs( sin( 13.0 * value.y + value.x ) ) ) );
	}
	float hash3D( vec3 value ) {
		return hash2D( vec2( hash2D( value.xy ), value.z ) );
	}
	float getAlphaHashThreshold( vec3 position ) {
		float maxDeriv = max(
			length( dFdx( position.xyz ) ),
			length( dFdy( position.xyz ) )
		);
		float pixScale = 1.0 / ( ALPHA_HASH_SCALE * maxDeriv );
		vec2 pixScales = vec2(
			exp2( floor( log2( pixScale ) ) ),
			exp2( ceil( log2( pixScale ) ) )
		);
		vec2 alpha = vec2(
			hash3D( floor( pixScales.x * position.xyz ) ),
			hash3D( floor( pixScales.y * position.xyz ) )
		);
		float lerpFactor = fract( log2( pixScale ) );
		float x = ( 1.0 - lerpFactor ) * alpha.x + lerpFactor * alpha.y;
		float a = min( lerpFactor, 1.0 - lerpFactor );
		vec3 cases = vec3(
			x * x / ( 2.0 * a * ( 1.0 - a ) ),
			( x - 0.5 * a ) / ( 1.0 - a ),
			1.0 - ( ( 1.0 - x ) * ( 1.0 - x ) / ( 2.0 * a * ( 1.0 - a ) ) )
		);
		float threshold = ( x < ( 1.0 - a ) )
			? ( ( x < a ) ? cases.x : cases.y )
			: cases.z;
		return clamp( threshold , 1.0e-6, 1.0 );
	}
#endif`,sv=`#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
#endif`,rv=`#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,ov=`#ifdef USE_ALPHATEST
	#ifdef ALPHA_TO_COVERAGE
	diffuseColor.a = smoothstep( alphaTest, alphaTest + fwidth( diffuseColor.a ), diffuseColor.a );
	if ( diffuseColor.a == 0.0 ) discard;
	#else
	if ( diffuseColor.a < alphaTest ) discard;
	#endif
#endif`,av=`#ifdef USE_ALPHATEST
	uniform float alphaTest;
#endif`,lv=`#ifdef USE_AOMAP
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
#endif`,cv=`#ifdef USE_AOMAP
	uniform sampler2D aoMap;
	uniform float aoMapIntensity;
#endif`,uv=`#ifdef USE_BATCHING
	#if ! defined( GL_ANGLE_multi_draw )
	#define gl_DrawID _gl_DrawID
	uniform int _gl_DrawID;
	#endif
	uniform highp sampler2D batchingTexture;
	uniform highp usampler2D batchingIdTexture;
	mat4 getBatchingMatrix( const in float i ) {
		int size = textureSize( batchingTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( batchingTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( batchingTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( batchingTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( batchingTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
	float getIndirectIndex( const in int i ) {
		int size = textureSize( batchingIdTexture, 0 ).x;
		int x = i % size;
		int y = i / size;
		return float( texelFetch( batchingIdTexture, ivec2( x, y ), 0 ).r );
	}
#endif
#ifdef USE_BATCHING_COLOR
	uniform sampler2D batchingColorTexture;
	vec3 getBatchingColor( const in float i ) {
		int size = textureSize( batchingColorTexture, 0 ).x;
		int j = int( i );
		int x = j % size;
		int y = j / size;
		return texelFetch( batchingColorTexture, ivec2( x, y ), 0 ).rgb;
	}
#endif`,hv=`#ifdef USE_BATCHING
	mat4 batchingMatrix = getBatchingMatrix( getIndirectIndex( gl_DrawID ) );
#endif`,fv=`vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif`,dv=`vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif`,pv=`float G_BlinnPhong_Implicit( ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
} // validated`,mv=`#ifdef USE_IRIDESCENCE
	const mat3 XYZ_TO_REC709 = mat3(
		 3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);
	vec3 Fresnel0ToIor( vec3 fresnel0 ) {
		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
	}
	vec3 IorToFresnel0( vec3 transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
	}
	float IorToFresnel0( float transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ));
	}
	vec3 evalSensitivity( float OPD, vec3 shift ) {
		float phase = 2.0 * PI * OPD * 1.0e-9;
		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - pow2( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * pow2( phase ) );
		xyz /= 1.0685e-7;
		vec3 rgb = XYZ_TO_REC709 * xyz;
		return rgb;
	}
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
		vec3 I;
		float iridescenceIOR = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
		float sinTheta2Sq = pow2( outsideIOR / iridescenceIOR ) * ( 1.0 - pow2( cosTheta1 ) );
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {
			return vec3( 1.0 );
		}
		float cosTheta2 = sqrt( cosTheta2Sq );
		float R0 = IorToFresnel0( iridescenceIOR, outsideIOR );
		float R12 = F_Schlick( R0, 1.0, cosTheta1 );
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIOR < outsideIOR ) phi12 = PI;
		float phi21 = PI - phi12;
		vec3 baseIOR = Fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) );		vec3 R1 = IorToFresnel0( baseIOR, iridescenceIOR );
		vec3 R23 = F_Schlick( R1, 1.0, cosTheta2 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[ 0 ] < iridescenceIOR ) phi23[ 0 ] = PI;
		if ( baseIOR[ 1 ] < iridescenceIOR ) phi23[ 1 ] = PI;
		if ( baseIOR[ 2 ] < iridescenceIOR ) phi23[ 2 ] = PI;
		float OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = pow2( T121 ) * R23 / ( vec3( 1.0 ) - R123 );
		vec3 C0 = R12 + Rs;
		I = C0;
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {
			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;
		}
		return max( I, vec3( 0.0 ) );
	}
#endif`,_v=`#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
		vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif`,gv=`#if NUM_CLIPPING_PLANES > 0
	vec4 plane;
	#ifdef ALPHA_TO_COVERAGE
		float distanceToPlane, distanceGradient;
		float clipOpacity = 1.0;
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
			distanceGradient = fwidth( distanceToPlane ) / 2.0;
			clipOpacity *= smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			if ( clipOpacity == 0.0 ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			float unionClipOpacity = 1.0;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				distanceToPlane = - dot( vClipPosition, plane.xyz ) + plane.w;
				distanceGradient = fwidth( distanceToPlane ) / 2.0;
				unionClipOpacity *= 1.0 - smoothstep( - distanceGradient, distanceGradient, distanceToPlane );
			}
			#pragma unroll_loop_end
			clipOpacity *= 1.0 - unionClipOpacity;
		#endif
		diffuseColor.a *= clipOpacity;
		if ( diffuseColor.a == 0.0 ) discard;
	#else
		#pragma unroll_loop_start
		for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;
		}
		#pragma unroll_loop_end
		#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
			bool clipped = true;
			#pragma unroll_loop_start
			for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
				plane = clippingPlanes[ i ];
				clipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;
			}
			#pragma unroll_loop_end
			if ( clipped ) discard;
		#endif
	#endif
#endif`,vv=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif`,xv=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
#endif`,yv=`#if NUM_CLIPPING_PLANES > 0
	vClipPosition = - mvPosition.xyz;
#endif`,Mv=`#if defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#elif defined( USE_COLOR )
	diffuseColor.rgb *= vColor;
#endif`,Sv=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR )
	varying vec3 vColor;
#endif`,Ev=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	varying vec3 vColor;
#endif`,bv=`#if defined( USE_COLOR_ALPHA )
	vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
	vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
	vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.xyz *= instanceColor.xyz;
#endif
#ifdef USE_BATCHING_COLOR
	vec3 batchingColor = getBatchingColor( getIndirectIndex( gl_DrawID ) );
	vColor.xyz *= batchingColor.xyz;
#endif`,Tv=`#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define EPSILON 1e-6
#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
#define whiteComplement( a ) ( 1.0 - saturate( a ) )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow3( const in float x ) { return x*x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
float max3( const in vec3 v ) { return max( max( v.x, v.y ), v.z ); }
float average( const in vec3 v ) { return dot( v, vec3( 0.3333333 ) ); }
highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract( sin( sn ) * c );
}
#ifdef HIGH_PRECISION
	float precisionSafeLength( vec3 v ) { return length( v ); }
#else
	float precisionSafeLength( vec3 v ) {
		float maxComponent = max3( abs( v ) );
		return length( v / maxComponent ) * maxComponent;
	}
#endif
struct IncidentLight {
	vec3 color;
	vec3 direction;
	bool visible;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
#ifdef USE_ALPHAHASH
	varying vec3 vPosition;
#endif
vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );
}
vec3 inverseTransformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( vec4( dir, 0.0 ) * matrix ).xyz );
}
mat3 transposeMat3( const in mat3 m ) {
	mat3 tmp;
	tmp[ 0 ] = vec3( m[ 0 ].x, m[ 1 ].x, m[ 2 ].x );
	tmp[ 1 ] = vec3( m[ 0 ].y, m[ 1 ].y, m[ 2 ].y );
	tmp[ 2 ] = vec3( m[ 0 ].z, m[ 1 ].z, m[ 2 ].z );
	return tmp;
}
bool isPerspectiveMatrix( mat4 m ) {
	return m[ 2 ][ 3 ] == - 1.0;
}
vec2 equirectUv( in vec3 dir ) {
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	return vec2( u, v );
}
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
float F_Schlick( const in float f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
} // validated`,Av=`#ifdef ENVMAP_TYPE_CUBE_UV
	#define cubeUV_minMipLevel 4.0
	#define cubeUV_minTileSize 16.0
	float getFace( vec3 direction ) {
		vec3 absDirection = abs( direction );
		float face = - 1.0;
		if ( absDirection.x > absDirection.z ) {
			if ( absDirection.x > absDirection.y )
				face = direction.x > 0.0 ? 0.0 : 3.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		} else {
			if ( absDirection.z > absDirection.y )
				face = direction.z > 0.0 ? 2.0 : 5.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		}
		return face;
	}
	vec2 getUV( vec3 direction, float face ) {
		vec2 uv;
		if ( face == 0.0 ) {
			uv = vec2( direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 1.0 ) {
			uv = vec2( - direction.x, - direction.z ) / abs( direction.y );
		} else if ( face == 2.0 ) {
			uv = vec2( - direction.x, direction.y ) / abs( direction.z );
		} else if ( face == 3.0 ) {
			uv = vec2( - direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 4.0 ) {
			uv = vec2( - direction.x, direction.z ) / abs( direction.y );
		} else {
			uv = vec2( direction.x, direction.y ) / abs( direction.z );
		}
		return 0.5 * ( uv + 1.0 );
	}
	vec3 bilinearCubeUV( sampler2D envMap, vec3 direction, float mipInt ) {
		float face = getFace( direction );
		float filterInt = max( cubeUV_minMipLevel - mipInt, 0.0 );
		mipInt = max( mipInt, cubeUV_minMipLevel );
		float faceSize = exp2( mipInt );
		highp vec2 uv = getUV( direction, face ) * ( faceSize - 2.0 ) + 1.0;
		if ( face > 2.0 ) {
			uv.y += faceSize;
			face -= 3.0;
		}
		uv.x += face * faceSize;
		uv.x += filterInt * 3.0 * cubeUV_minTileSize;
		uv.y += 4.0 * ( exp2( CUBEUV_MAX_MIP ) - faceSize );
		uv.x *= CUBEUV_TEXEL_WIDTH;
		uv.y *= CUBEUV_TEXEL_HEIGHT;
		#ifdef texture2DGradEXT
			return texture2DGradEXT( envMap, uv, vec2( 0.0 ), vec2( 0.0 ) ).rgb;
		#else
			return texture2D( envMap, uv ).rgb;
		#endif
	}
	#define cubeUV_r0 1.0
	#define cubeUV_m0 - 2.0
	#define cubeUV_r1 0.8
	#define cubeUV_m1 - 1.0
	#define cubeUV_r4 0.4
	#define cubeUV_m4 2.0
	#define cubeUV_r5 0.305
	#define cubeUV_m5 3.0
	#define cubeUV_r6 0.21
	#define cubeUV_m6 4.0
	float roughnessToMip( float roughness ) {
		float mip = 0.0;
		if ( roughness >= cubeUV_r1 ) {
			mip = ( cubeUV_r0 - roughness ) * ( cubeUV_m1 - cubeUV_m0 ) / ( cubeUV_r0 - cubeUV_r1 ) + cubeUV_m0;
		} else if ( roughness >= cubeUV_r4 ) {
			mip = ( cubeUV_r1 - roughness ) * ( cubeUV_m4 - cubeUV_m1 ) / ( cubeUV_r1 - cubeUV_r4 ) + cubeUV_m1;
		} else if ( roughness >= cubeUV_r5 ) {
			mip = ( cubeUV_r4 - roughness ) * ( cubeUV_m5 - cubeUV_m4 ) / ( cubeUV_r4 - cubeUV_r5 ) + cubeUV_m4;
		} else if ( roughness >= cubeUV_r6 ) {
			mip = ( cubeUV_r5 - roughness ) * ( cubeUV_m6 - cubeUV_m5 ) / ( cubeUV_r5 - cubeUV_r6 ) + cubeUV_m5;
		} else {
			mip = - 2.0 * log2( 1.16 * roughness );		}
		return mip;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {
		float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );
		float mipF = fract( mip );
		float mipInt = floor( mip );
		vec3 color0 = bilinearCubeUV( envMap, sampleDir, mipInt );
		if ( mipF == 0.0 ) {
			return vec4( color0, 1.0 );
		} else {
			vec3 color1 = bilinearCubeUV( envMap, sampleDir, mipInt + 1.0 );
			return vec4( mix( color0, color1, mipF ), 1.0 );
		}
	}
#endif`,wv=`vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
	vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
	mat3 bm = mat3( batchingMatrix );
	transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
	transformedNormal = bm * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = bm * transformedTangent;
	#endif
#endif
#ifdef USE_INSTANCING
	mat3 im = mat3( instanceMatrix );
	transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	transformedNormal = im * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = im * transformedTangent;
	#endif
#endif
transformedNormal = normalMatrix * transformedNormal;
#ifdef FLIP_SIDED
	transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
	transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
	#ifdef FLIP_SIDED
		transformedTangent = - transformedTangent;
	#endif
#endif`,Rv=`#ifdef USE_DISPLACEMENTMAP
	uniform sampler2D displacementMap;
	uniform float displacementScale;
	uniform float displacementBias;
#endif`,Cv=`#ifdef USE_DISPLACEMENTMAP
	transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale + displacementBias );
#endif`,Pv=`#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
	#ifdef DECODE_VIDEO_TEXTURE_EMISSIVE
		emissiveColor = sRGBTransferEOTF( emissiveColor );
	#endif
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,Dv=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,Lv="gl_FragColor = linearToOutputTexel( gl_FragColor );",Iv=`vec4 LinearTransferOETF( in vec4 value ) {
	return value;
}
vec4 sRGBTransferEOTF( in vec4 value ) {
	return vec4( mix( pow( value.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), value.rgb * 0.0773993808, vec3( lessThanEqual( value.rgb, vec3( 0.04045 ) ) ) ), value.a );
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}`,Uv=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vec3 cameraToFrag;
		if ( isOrthographic ) {
			cameraToFrag = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToFrag = normalize( vWorldPosition - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( cameraToFrag, worldNormal );
		#else
			vec3 reflectVec = refract( cameraToFrag, worldNormal, refractionRatio );
		#endif
	#else
		vec3 reflectVec = vReflect;
	#endif
	#ifdef ENVMAP_TYPE_CUBE
		vec4 envColor = textureCube( envMap, envMapRotation * vec3( flipEnvMap * reflectVec.x, reflectVec.yz ) );
	#else
		vec4 envColor = vec4( 0.0 );
	#endif
	#ifdef ENVMAP_BLENDING_MULTIPLY
		outgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_MIX )
		outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_ADD )
		outgoingLight += envColor.xyz * specularStrength * reflectivity;
	#endif
#endif`,Nv=`#ifdef USE_ENVMAP
	uniform float envMapIntensity;
	uniform float flipEnvMap;
	uniform mat3 envMapRotation;
	#ifdef ENVMAP_TYPE_CUBE
		uniform samplerCube envMap;
	#else
		uniform sampler2D envMap;
	#endif
	
#endif`,Ov=`#ifdef USE_ENVMAP
	uniform float reflectivity;
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		varying vec3 vWorldPosition;
		uniform float refractionRatio;
	#else
		varying vec3 vReflect;
	#endif
#endif`,Fv=`#ifdef USE_ENVMAP
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		
		varying vec3 vWorldPosition;
	#else
		varying vec3 vReflect;
		uniform float refractionRatio;
	#endif
#endif`,Bv=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vWorldPosition = worldPosition.xyz;
	#else
		vec3 cameraToVertex;
		if ( isOrthographic ) {
			cameraToVertex = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToVertex = normalize( worldPosition.xyz - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vReflect = reflect( cameraToVertex, worldNormal );
		#else
			vReflect = refract( cameraToVertex, worldNormal, refractionRatio );
		#endif
	#endif
#endif`,zv=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif`,kv=`#ifdef USE_FOG
	varying float vFogDepth;
#endif`,Hv=`#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,Vv=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,Gv=`#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
	#ifdef USE_GRADIENTMAP
		return vec3( texture2D( gradientMap, coord ).r );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}`,Wv=`#ifdef USE_LIGHTMAP
	uniform sampler2D lightMap;
	uniform float lightMapIntensity;
#endif`,Xv=`LambertMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularStrength = specularStrength;`,qv=`varying vec3 vViewPosition;
struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Lambert
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert`,Yv=`uniform bool receiveShadow;
uniform vec3 ambientLightColor;
#if defined( USE_LIGHT_PROBES )
	uniform vec3 lightProbe[ 9 ];
#endif
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
vec3 getLightProbeIrradiance( const in vec3 lightProbe[ 9 ], const in vec3 normal ) {
	vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
	vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );
	return irradiance;
}
vec3 getAmbientLightIrradiance( const in vec3 ambientLightColor ) {
	vec3 irradiance = ambientLightColor;
	return irradiance;
}
float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
	if ( cutoffDistance > 0.0 ) {
		distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
	}
	return distanceFalloff;
}
float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {
	return smoothstep( coneCosine, penumbraCosine, angleCosine );
}
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
	void getDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
		light.color = directionalLight.color;
		light.direction = directionalLight.direction;
		light.visible = true;
	}
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = pointLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float lightDistance = length( lVector );
		light.color = pointLight.color;
		light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
		light.visible = ( light.color != vec3( 0.0 ) );
	}
#endif
#if NUM_SPOT_LIGHTS > 0
	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};
	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
	void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = spotLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float angleCos = dot( light.direction, spotLight.direction );
		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );
		if ( spotAttenuation > 0.0 ) {
			float lightDistance = length( lVector );
			light.color = spotLight.color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		} else {
			light.color = vec3( 0.0 );
			light.visible = false;
		}
	}
#endif
#if NUM_RECT_AREA_LIGHTS > 0
	struct RectAreaLight {
		vec3 color;
		vec3 position;
		vec3 halfWidth;
		vec3 halfHeight;
	};
	uniform sampler2D ltc_1;	uniform sampler2D ltc_2;
	uniform RectAreaLight rectAreaLights[ NUM_RECT_AREA_LIGHTS ];
#endif
#if NUM_HEMI_LIGHTS > 0
	struct HemisphereLight {
		vec3 direction;
		vec3 skyColor;
		vec3 groundColor;
	};
	uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];
	vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {
		float dotNL = dot( normal, hemiLight.direction );
		float hemiDiffuseWeight = 0.5 * dotNL + 0.5;
		vec3 irradiance = mix( hemiLight.groundColor, hemiLight.skyColor, hemiDiffuseWeight );
		return irradiance;
	}
#endif`,jv=`#ifdef USE_ENVMAP
	vec3 getIBLIrradiance( const in vec3 normal ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
			return PI * envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
			reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 bentNormal = cross( bitangent, viewDir );
				bentNormal = normalize( cross( bentNormal, bitangent ) );
				bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
				return getIBLRadiance( viewDir, bentNormal, roughness );
			#else
				return vec3( 0.0 );
			#endif
		}
	#endif
#endif`,Kv=`ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;`,$v=`varying vec3 vViewPosition;
struct ToonMaterial {
	vec3 diffuseColor;
};
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Toon
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Toon`,Zv=`BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularColor = specular;
material.specularShininess = shininess;
material.specularStrength = specularStrength;`,Jv=`varying vec3 vViewPosition;
struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_BlinnPhong
#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong`,Qv=`PhysicalMaterial material;
material.diffuseColor = diffuseColor.rgb * ( 1.0 - metalnessFactor );
vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );
float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );
material.roughness = max( roughnessFactor, 0.0525 );material.roughness += geometryRoughness;
material.roughness = min( material.roughness, 1.0 );
#ifdef IOR
	material.ior = ior;
	#ifdef USE_SPECULAR
		float specularIntensityFactor = specularIntensity;
		vec3 specularColorFactor = specularColor;
		#ifdef USE_SPECULAR_COLORMAP
			specularColorFactor *= texture2D( specularColorMap, vSpecularColorMapUv ).rgb;
		#endif
		#ifdef USE_SPECULAR_INTENSITYMAP
			specularIntensityFactor *= texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a;
		#endif
		material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
	#else
		float specularIntensityFactor = 1.0;
		vec3 specularColorFactor = vec3( 1.0 );
		material.specularF90 = 1.0;
	#endif
	material.specularColor = mix( min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor, diffuseColor.rgb, metalnessFactor );
#else
	material.specularColor = mix( vec3( 0.04 ), diffuseColor.rgb, metalnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef USE_CLEARCOAT
	material.clearcoat = clearcoat;
	material.clearcoatRoughness = clearcoatRoughness;
	material.clearcoatF0 = vec3( 0.04 );
	material.clearcoatF90 = 1.0;
	#ifdef USE_CLEARCOATMAP
		material.clearcoat *= texture2D( clearcoatMap, vClearcoatMapUv ).x;
	#endif
	#ifdef USE_CLEARCOAT_ROUGHNESSMAP
		material.clearcoatRoughness *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
	#endif
	material.clearcoat = saturate( material.clearcoat );	material.clearcoatRoughness = max( material.clearcoatRoughness, 0.0525 );
	material.clearcoatRoughness += geometryRoughness;
	material.clearcoatRoughness = min( material.clearcoatRoughness, 1.0 );
#endif
#ifdef USE_DISPERSION
	material.dispersion = dispersion;
#endif
#ifdef USE_IRIDESCENCE
	material.iridescence = iridescence;
	material.iridescenceIOR = iridescenceIOR;
	#ifdef USE_IRIDESCENCEMAP
		material.iridescence *= texture2D( iridescenceMap, vIridescenceMapUv ).r;
	#endif
	#ifdef USE_IRIDESCENCE_THICKNESSMAP
		material.iridescenceThickness = (iridescenceThicknessMaximum - iridescenceThicknessMinimum) * texture2D( iridescenceThicknessMap, vIridescenceThicknessMapUv ).g + iridescenceThicknessMinimum;
	#else
		material.iridescenceThickness = iridescenceThicknessMaximum;
	#endif
#endif
#ifdef USE_SHEEN
	material.sheenColor = sheenColor;
	#ifdef USE_SHEEN_COLORMAP
		material.sheenColor *= texture2D( sheenColorMap, vSheenColorMapUv ).rgb;
	#endif
	material.sheenRoughness = clamp( sheenRoughness, 0.07, 1.0 );
	#ifdef USE_SHEEN_ROUGHNESSMAP
		material.sheenRoughness *= texture2D( sheenRoughnessMap, vSheenRoughnessMapUv ).a;
	#endif
#endif
#ifdef USE_ANISOTROPY
	#ifdef USE_ANISOTROPYMAP
		mat2 anisotropyMat = mat2( anisotropyVector.x, anisotropyVector.y, - anisotropyVector.y, anisotropyVector.x );
		vec3 anisotropyPolar = texture2D( anisotropyMap, vAnisotropyMapUv ).rgb;
		vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;
	#else
		vec2 anisotropyV = anisotropyVector;
	#endif
	material.anisotropy = length( anisotropyV );
	if( material.anisotropy == 0.0 ) {
		anisotropyV = vec2( 1.0, 0.0 );
	} else {
		anisotropyV /= material.anisotropy;
		material.anisotropy = saturate( material.anisotropy );
	}
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
	material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
#endif`,t0=`struct PhysicalMaterial {
	vec3 diffuseColor;
	float roughness;
	vec3 specularColor;
	float specularF90;
	float dispersion;
	#ifdef USE_CLEARCOAT
		float clearcoat;
		float clearcoatRoughness;
		vec3 clearcoatF0;
		float clearcoatF90;
	#endif
	#ifdef USE_IRIDESCENCE
		float iridescence;
		float iridescenceIOR;
		float iridescenceThickness;
		vec3 iridescenceFresnel;
		vec3 iridescenceF0;
	#endif
	#ifdef USE_SHEEN
		vec3 sheenColor;
		float sheenRoughness;
	#endif
	#ifdef IOR
		float ior;
	#endif
	#ifdef USE_TRANSMISSION
		float transmission;
		float transmissionAlpha;
		float thickness;
		float attenuationDistance;
		vec3 attenuationColor;
	#endif
	#ifdef USE_ANISOTROPY
		float anisotropy;
		float alphaT;
		vec3 anisotropyT;
		vec3 anisotropyB;
	#endif
};
vec3 clearcoatSpecularDirect = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
vec3 sheenSpecularDirect = vec3( 0.0 );
vec3 sheenSpecularIndirect = vec3(0.0 );
vec3 Schlick_to_F0( const in vec3 f, const in float f90, const in float dotVH ) {
    float x = clamp( 1.0 - dotVH, 0.0, 1.0 );
    float x2 = x * x;
    float x5 = clamp( x * x2 * x2, 0.0, 0.9999 );
    return ( f - vec3( f90 ) * x5 ) / ( 1.0 - x5 );
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
#ifdef USE_ANISOTROPY
	float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB, const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL, const in float dotNV, const in float dotNL ) {
		float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
		float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
		float v = 0.5 / ( gv + gl );
		return saturate(v);
	}
	float D_GGX_Anisotropic( const in float alphaT, const in float alphaB, const in float dotNH, const in float dotTH, const in float dotBH ) {
		float a2 = alphaT * alphaB;
		highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
		highp float v2 = dot( v, v );
		float w2 = a2 / v2;
		return RECIPROCAL_PI * a2 * pow2 ( w2 );
	}
#endif
#ifdef USE_CLEARCOAT
	vec3 BRDF_GGX_Clearcoat( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material) {
		vec3 f0 = material.clearcoatF0;
		float f90 = material.clearcoatF90;
		float roughness = material.clearcoatRoughness;
		float alpha = pow2( roughness );
		vec3 halfDir = normalize( lightDir + viewDir );
		float dotNL = saturate( dot( normal, lightDir ) );
		float dotNV = saturate( dot( normal, viewDir ) );
		float dotNH = saturate( dot( normal, halfDir ) );
		float dotVH = saturate( dot( viewDir, halfDir ) );
		vec3 F = F_Schlick( f0, f90, dotVH );
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
		return F * ( V * D );
	}
#endif
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColor;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	#ifdef USE_IRIDESCENCE
		F = mix( F, material.iridescenceFresnel, material.iridescence );
	#endif
	#ifdef USE_ANISOTROPY
		float dotTL = dot( material.anisotropyT, lightDir );
		float dotTV = dot( material.anisotropyT, viewDir );
		float dotTH = dot( material.anisotropyT, halfDir );
		float dotBL = dot( material.anisotropyB, lightDir );
		float dotBV = dot( material.anisotropyB, viewDir );
		float dotBH = dot( material.anisotropyB, halfDir );
		float V = V_GGX_SmithCorrelated_Anisotropic( material.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL );
		float D = D_GGX_Anisotropic( material.alphaT, alpha, dotNH, dotTH, dotBH );
	#else
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
	#endif
	return F * ( V * D );
}
vec2 LTC_Uv( const in vec3 N, const in vec3 V, const in float roughness ) {
	const float LUT_SIZE = 64.0;
	const float LUT_SCALE = ( LUT_SIZE - 1.0 ) / LUT_SIZE;
	const float LUT_BIAS = 0.5 / LUT_SIZE;
	float dotNV = saturate( dot( N, V ) );
	vec2 uv = vec2( roughness, sqrt( 1.0 - dotNV ) );
	uv = uv * LUT_SCALE + LUT_BIAS;
	return uv;
}
float LTC_ClippedSphereFormFactor( const in vec3 f ) {
	float l = length( f );
	return max( ( l * l + f.z ) / ( l + 1.0 ), 0.0 );
}
vec3 LTC_EdgeVectorFormFactor( const in vec3 v1, const in vec3 v2 ) {
	float x = dot( v1, v2 );
	float y = abs( x );
	float a = 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y;
	float b = 3.4175940 + ( 4.1616724 + y ) * y;
	float v = a / b;
	float theta_sintheta = ( x > 0.0 ) ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( v1, v2 ) * theta_sintheta;
}
vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
	vec3 v1 = rectCoords[ 1 ] - rectCoords[ 0 ];
	vec3 v2 = rectCoords[ 3 ] - rectCoords[ 0 ];
	vec3 lightNormal = cross( v1, v2 );
	if( dot( lightNormal, P - rectCoords[ 0 ] ) < 0.0 ) return vec3( 0.0 );
	vec3 T1, T2;
	T1 = normalize( V - N * dot( V, N ) );
	T2 = - cross( N, T1 );
	mat3 mat = mInv * transposeMat3( mat3( T1, T2, N ) );
	vec3 coords[ 4 ];
	coords[ 0 ] = mat * ( rectCoords[ 0 ] - P );
	coords[ 1 ] = mat * ( rectCoords[ 1 ] - P );
	coords[ 2 ] = mat * ( rectCoords[ 2 ] - P );
	coords[ 3 ] = mat * ( rectCoords[ 3 ] - P );
	coords[ 0 ] = normalize( coords[ 0 ] );
	coords[ 1 ] = normalize( coords[ 1 ] );
	coords[ 2 ] = normalize( coords[ 2 ] );
	coords[ 3 ] = normalize( coords[ 3 ] );
	vec3 vectorFormFactor = vec3( 0.0 );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 0 ], coords[ 1 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 1 ], coords[ 2 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 2 ], coords[ 3 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 3 ], coords[ 0 ] );
	float result = LTC_ClippedSphereFormFactor( vectorFormFactor );
	return vec3( result );
}
#if defined( USE_SHEEN )
float D_Charlie( float roughness, float dotNH ) {
	float alpha = pow2( roughness );
	float invAlpha = 1.0 / alpha;
	float cos2h = dotNH * dotNH;
	float sin2h = max( 1.0 - cos2h, 0.0078125 );
	return ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
}
float V_Neubelt( float dotNV, float dotNL ) {
	return saturate( 1.0 / ( 4.0 * ( dotNL + dotNV - dotNL * dotNV ) ) );
}
vec3 BRDF_Sheen( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, vec3 sheenColor, const in float sheenRoughness ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float D = D_Charlie( sheenRoughness, dotNH );
	float V = V_Neubelt( dotNV, dotNL );
	return sheenColor * ( D * V );
}
#endif
float IBLSheenBRDF( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	float r2 = roughness * roughness;
	float a = roughness < 0.25 ? -339.2 * r2 + 161.4 * roughness - 25.9 : -8.48 * r2 + 14.3 * roughness - 9.95;
	float b = roughness < 0.25 ? 44.0 * r2 - 23.7 * roughness + 3.26 : 1.97 * r2 - 3.27 * roughness + 0.72;
	float DG = exp( a * dotNV + b ) + ( roughness < 0.25 ? 0.0 : 0.1 * ( roughness - 0.25 ) );
	return saturate( DG * RECIPROCAL_PI );
}
vec2 DFGApprox( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	const vec4 c0 = vec4( - 1, - 0.0275, - 0.572, 0.022 );
	const vec4 c1 = vec4( 1, 0.0425, 1.04, - 0.04 );
	vec4 r = roughness * c0 + c1;
	float a004 = min( r.x * r.x, exp2( - 9.28 * dotNV ) ) * r.x + r.y;
	vec2 fab = vec2( - 1.04, 1.04 ) * a004 + r.zw;
	return fab;
}
vec3 EnvironmentBRDF( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness ) {
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	return specularColor * fab.x + specularF90 * fab.y;
}
#ifdef USE_IRIDESCENCE
void computeMultiscatteringIridescence( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float iridescence, const in vec3 iridescenceF0, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#else
void computeMultiscattering( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#endif
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	#ifdef USE_IRIDESCENCE
		vec3 Fr = mix( specularColor, iridescenceF0, iridescence );
	#else
		vec3 Fr = specularColor;
	#endif
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619;	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
#if NUM_RECT_AREA_LIGHTS > 0
	void RE_Direct_RectArea_Physical( const in RectAreaLight rectAreaLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
		vec3 normal = geometryNormal;
		vec3 viewDir = geometryViewDir;
		vec3 position = geometryPosition;
		vec3 lightPos = rectAreaLight.position;
		vec3 halfWidth = rectAreaLight.halfWidth;
		vec3 halfHeight = rectAreaLight.halfHeight;
		vec3 lightColor = rectAreaLight.color;
		float roughness = material.roughness;
		vec3 rectCoords[ 4 ];
		rectCoords[ 0 ] = lightPos + halfWidth - halfHeight;		rectCoords[ 1 ] = lightPos - halfWidth - halfHeight;
		rectCoords[ 2 ] = lightPos - halfWidth + halfHeight;
		rectCoords[ 3 ] = lightPos + halfWidth + halfHeight;
		vec2 uv = LTC_Uv( normal, viewDir, roughness );
		vec4 t1 = texture2D( ltc_1, uv );
		vec4 t2 = texture2D( ltc_2, uv );
		mat3 mInv = mat3(
			vec3( t1.x, 0, t1.y ),
			vec3(    0, 1,    0 ),
			vec3( t1.z, 0, t1.w )
		);
		vec3 fresnel = ( material.specularColor * t2.x + ( vec3( 1.0 ) - material.specularColor ) * t2.y );
		reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
		reflectedLight.directDiffuse += lightColor * material.diffuseColor * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
	}
#endif
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
	#endif
	reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Physical( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
	#ifdef USE_CLEARCOAT
		clearcoatSpecularIndirect += clearcoatRadiance * EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularIndirect += irradiance * material.sheenColor * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
	#endif
	vec3 singleScattering = vec3( 0.0 );
	vec3 multiScattering = vec3( 0.0 );
	vec3 cosineWeightedIrradiance = irradiance * RECIPROCAL_PI;
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.iridescence, material.iridescenceFresnel, material.roughness, singleScattering, multiScattering );
	#else
		computeMultiscattering( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.roughness, singleScattering, multiScattering );
	#endif
	vec3 totalScattering = singleScattering + multiScattering;
	vec3 diffuse = material.diffuseColor * ( 1.0 - max( max( totalScattering.r, totalScattering.g ), totalScattering.b ) );
	reflectedLight.indirectSpecular += radiance * singleScattering;
	reflectedLight.indirectSpecular += multiScattering * cosineWeightedIrradiance;
	reflectedLight.indirectDiffuse += diffuse * cosineWeightedIrradiance;
}
#define RE_Direct				RE_Direct_Physical
#define RE_Direct_RectArea		RE_Direct_RectArea_Physical
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Physical
#define RE_IndirectSpecular		RE_IndirectSpecular_Physical
float computeSpecularOcclusion( const in float dotNV, const in float ambientOcclusion, const in float roughness ) {
	return saturate( pow( dotNV + ambientOcclusion, exp2( - 16.0 * roughness - 1.0 ) ) - 1.0 + ambientOcclusion );
}`,e0=`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
#ifdef USE_CLEARCOAT
	geometryClearcoatNormal = clearcoatNormal;
#endif
#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		material.iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		material.iridescenceF0 = Schlick_to_F0( material.iridescenceFresnel, 1.0, dotNVi );
	}
#endif
IncidentLight directLight;
#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		getPointLightInfo( pointLight, geometryPosition, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
	RectAreaLight rectAreaLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if defined( RE_IndirectDiffuse )
	vec3 iblIrradiance = vec3( 0.0 );
	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_LIGHT_PROBES )
		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
#endif
#if defined( RE_IndirectSpecular )
	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );
#endif`,n0=`#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
		irradiance += lightMapIrradiance;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
		iblIrradiance += getIBLIrradiance( geometryNormal );
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	#ifdef USE_ANISOTROPY
		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
	#else
		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#endif
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif`,i0=`#if defined( RE_IndirectDiffuse )
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
#if defined( RE_IndirectSpecular )
	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,s0=`#if defined( USE_LOGDEPTHBUF )
	gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif`,r0=`#if defined( USE_LOGDEPTHBUF )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,o0=`#ifdef USE_LOGDEPTHBUF
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,a0=`#ifdef USE_LOGDEPTHBUF
	vFragDepth = 1.0 + gl_Position.w;
	vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
#endif`,l0=`#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`,c0=`#ifdef USE_MAP
	uniform sampler2D map;
#endif`,u0=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
	#if defined( USE_POINTS_UV )
		vec2 uv = vUv;
	#else
		vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;
	#endif
#endif
#ifdef USE_MAP
	diffuseColor *= texture2D( map, uv );
#endif
#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, uv ).g;
#endif`,h0=`#if defined( USE_POINTS_UV )
	varying vec2 vUv;
#else
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,f0=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
	metalnessFactor *= texelMetalness.b;
#endif`,d0=`#ifdef USE_METALNESSMAP
	uniform sampler2D metalnessMap;
#endif`,p0=`#ifdef USE_INSTANCING_MORPH
	float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	float morphTargetBaseInfluence = texelFetch( morphTexture, ivec2( 0, gl_InstanceID ), 0 ).r;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		morphTargetInfluences[i] =  texelFetch( morphTexture, ivec2( i + 1, gl_InstanceID ), 0 ).r;
	}
#endif`,m0=`#if defined( USE_MORPHCOLORS )
	vColor *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		#if defined( USE_COLOR_ALPHA )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ) * morphTargetInfluences[ i ];
		#elif defined( USE_COLOR )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ).rgb * morphTargetInfluences[ i ];
		#endif
	}
#endif`,_0=`#ifdef USE_MORPHNORMALS
	objectNormal *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) objectNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,g0=`#ifdef USE_MORPHTARGETS
	#ifndef USE_INSTANCING_MORPH
		uniform float morphTargetBaseInfluence;
		uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];
	#endif
	uniform sampler2DArray morphTargetsTexture;
	uniform ivec2 morphTargetsTextureSize;
	vec4 getMorph( const in int vertexIndex, const in int morphTargetIndex, const in int offset ) {
		int texelIndex = vertexIndex * MORPHTARGETS_TEXTURE_STRIDE + offset;
		int y = texelIndex / morphTargetsTextureSize.x;
		int x = texelIndex - y * morphTargetsTextureSize.x;
		ivec3 morphUV = ivec3( x, y, morphTargetIndex );
		return texelFetch( morphTargetsTexture, morphUV, 0 );
	}
#endif`,v0=`#ifdef USE_MORPHTARGETS
	transformed *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		if ( morphTargetInfluences[ i ] != 0.0 ) transformed += getMorph( gl_VertexID, i, 0 ).xyz * morphTargetInfluences[ i ];
	}
#endif`,x0=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
#ifdef FLAT_SHADED
	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );
#else
	vec3 normal = normalize( vNormal );
	#ifdef DOUBLE_SIDED
		normal *= faceDirection;
	#endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	#ifdef USE_TANGENT
		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`,y0=`#ifdef USE_NORMALMAP_OBJECTSPACE
	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`,M0=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,S0=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,E0=`#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
	#endif
#endif`,b0=`#ifdef USE_NORMALMAP
	uniform sampler2D normalMap;
	uniform vec2 normalScale;
#endif
#ifdef USE_NORMALMAP_OBJECTSPACE
	uniform mat3 normalMatrix;
#endif
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY ) )
	mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
		vec3 q0 = dFdx( eye_pos.xyz );
		vec3 q1 = dFdy( eye_pos.xyz );
		vec2 st0 = dFdx( uv.st );
		vec2 st1 = dFdy( uv.st );
		vec3 N = surf_norm;
		vec3 q1perp = cross( q1, N );
		vec3 q0perp = cross( N, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x;
		vec3 B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
		return mat3( T * scale, B * scale, N );
	}
#endif`,T0=`#ifdef USE_CLEARCOAT
	vec3 clearcoatNormal = nonPerturbedNormal;
#endif`,A0=`#ifdef USE_CLEARCOAT_NORMALMAP
	vec3 clearcoatMapN = texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0;
	clearcoatMapN.xy *= clearcoatNormalScale;
	clearcoatNormal = normalize( tbn2 * clearcoatMapN );
#endif`,w0=`#ifdef USE_CLEARCOATMAP
	uniform sampler2D clearcoatMap;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform sampler2D clearcoatNormalMap;
	uniform vec2 clearcoatNormalScale;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform sampler2D clearcoatRoughnessMap;
#endif`,R0=`#ifdef USE_IRIDESCENCEMAP
	uniform sampler2D iridescenceMap;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform sampler2D iridescenceThicknessMap;
#endif`,C0=`#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`,P0=`vec3 packNormalToRGB( const in vec3 normal ) {
	return normalize( normal ) * 0.5 + 0.5;
}
vec3 unpackRGBToNormal( const in vec3 rgb ) {
	return 2.0 * rgb.xyz - 1.0;
}
const float PackUpscale = 256. / 255.;const float UnpackDownscale = 255. / 256.;const float ShiftRight8 = 1. / 256.;
const float Inv255 = 1. / 255.;
const vec4 PackFactors = vec4( 1.0, 256.0, 256.0 * 256.0, 256.0 * 256.0 * 256.0 );
const vec2 UnpackFactors2 = vec2( UnpackDownscale, 1.0 / PackFactors.g );
const vec3 UnpackFactors3 = vec3( UnpackDownscale / PackFactors.rg, 1.0 / PackFactors.b );
const vec4 UnpackFactors4 = vec4( UnpackDownscale / PackFactors.rgb, 1.0 / PackFactors.a );
vec4 packDepthToRGBA( const in float v ) {
	if( v <= 0.0 )
		return vec4( 0., 0., 0., 0. );
	if( v >= 1.0 )
		return vec4( 1., 1., 1., 1. );
	float vuf;
	float af = modf( v * PackFactors.a, vuf );
	float bf = modf( vuf * ShiftRight8, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec4( vuf * Inv255, gf * PackUpscale, bf * PackUpscale, af );
}
vec3 packDepthToRGB( const in float v ) {
	if( v <= 0.0 )
		return vec3( 0., 0., 0. );
	if( v >= 1.0 )
		return vec3( 1., 1., 1. );
	float vuf;
	float bf = modf( v * PackFactors.b, vuf );
	float gf = modf( vuf * ShiftRight8, vuf );
	return vec3( vuf * Inv255, gf * PackUpscale, bf );
}
vec2 packDepthToRG( const in float v ) {
	if( v <= 0.0 )
		return vec2( 0., 0. );
	if( v >= 1.0 )
		return vec2( 1., 1. );
	float vuf;
	float gf = modf( v * 256., vuf );
	return vec2( vuf * Inv255, gf );
}
float unpackRGBAToDepth( const in vec4 v ) {
	return dot( v, UnpackFactors4 );
}
float unpackRGBToDepth( const in vec3 v ) {
	return dot( v, UnpackFactors3 );
}
float unpackRGToDepth( const in vec2 v ) {
	return v.r * UnpackFactors2.r + v.g * UnpackFactors2.g;
}
vec4 pack2HalfToRGBA( const in vec2 v ) {
	vec4 r = vec4( v.x, fract( v.x * 255.0 ), v.y, fract( v.y * 255.0 ) );
	return vec4( r.x - r.y / 255.0, r.y, r.z - r.w / 255.0, r.w );
}
vec2 unpackRGBATo2Half( const in vec4 v ) {
	return vec2( v.x + ( v.y / 255.0 ), v.z + ( v.w / 255.0 ) );
}
float viewZToOrthographicDepth( const in float viewZ, const in float near, const in float far ) {
	return ( viewZ + near ) / ( near - far );
}
float orthographicDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return depth * ( near - far ) - near;
}
float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}
float perspectiveDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return ( near * far ) / ( ( far - near ) * depth - far );
}`,D0=`#ifdef PREMULTIPLIED_ALPHA
	gl_FragColor.rgb *= gl_FragColor.a;
#endif`,L0=`vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,I0=`#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif`,U0=`#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif`,N0=`float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif`,O0=`#ifdef USE_ROUGHNESSMAP
	uniform sampler2D roughnessMap;
#endif`,F0=`#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform sampler2D pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
	float texture2DCompare( sampler2D depths, vec2 uv, float compare ) {
		return step( compare, unpackRGBAToDepth( texture2D( depths, uv ) ) );
	}
	vec2 texture2DDistribution( sampler2D shadow, vec2 uv ) {
		return unpackRGBATo2Half( texture2D( shadow, uv ) );
	}
	float VSMShadow (sampler2D shadow, vec2 uv, float compare ){
		float occlusion = 1.0;
		vec2 distribution = texture2DDistribution( shadow, uv );
		float hard_shadow = step( compare , distribution.x );
		if (hard_shadow != 1.0 ) {
			float distance = compare - distribution.x ;
			float variance = max( 0.00000, distribution.y * distribution.y );
			float softness_probability = variance / (variance + distance * distance );			softness_probability = clamp( ( softness_probability - 0.3 ) / ( 0.95 - 0.3 ), 0.0, 1.0 );			occlusion = clamp( max( hard_shadow, softness_probability ), 0.0, 1.0 );
		}
		return occlusion;
	}
	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
		float shadow = 1.0;
		shadowCoord.xyz /= shadowCoord.w;
		shadowCoord.z += shadowBias;
		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
		if ( frustumTest ) {
		#if defined( SHADOWMAP_TYPE_PCF )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx0 = - texelSize.x * shadowRadius;
			float dy0 = - texelSize.y * shadowRadius;
			float dx1 = + texelSize.x * shadowRadius;
			float dy1 = + texelSize.y * shadowRadius;
			float dx2 = dx0 / 2.0;
			float dy2 = dy0 / 2.0;
			float dx3 = dx1 / 2.0;
			float dy3 = dy1 / 2.0;
			shadow = (
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy1 ), shadowCoord.z )
			) * ( 1.0 / 17.0 );
		#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx = texelSize.x;
			float dy = texelSize.y;
			vec2 uv = shadowCoord.xy;
			vec2 f = fract( uv * shadowMapSize + 0.5 );
			uv -= f * texelSize;
			shadow = (
				texture2DCompare( shadowMap, uv, shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( dx, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( 0.0, dy ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + texelSize, shadowCoord.z ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, 0.0 ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 0.0 ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, dy ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( 0.0, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 0.0, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( texture2DCompare( shadowMap, uv + vec2( dx, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( dx, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( mix( texture2DCompare( shadowMap, uv + vec2( -dx, -dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, -dy ), shadowCoord.z ),
						  f.x ),
					 mix( texture2DCompare( shadowMap, uv + vec2( -dx, 2.0 * dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 2.0 * dy ), shadowCoord.z ),
						  f.x ),
					 f.y )
			) * ( 1.0 / 9.0 );
		#elif defined( SHADOWMAP_TYPE_VSM )
			shadow = VSMShadow( shadowMap, shadowCoord.xy, shadowCoord.z );
		#else
			shadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );
		#endif
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	vec2 cubeToUV( vec3 v, float texelSizeY ) {
		vec3 absV = abs( v );
		float scaleToCube = 1.0 / max( absV.x, max( absV.y, absV.z ) );
		absV *= scaleToCube;
		v *= scaleToCube * ( 1.0 - 2.0 * texelSizeY );
		vec2 planar = v.xy;
		float almostATexel = 1.5 * texelSizeY;
		float almostOne = 1.0 - almostATexel;
		if ( absV.z >= almostOne ) {
			if ( v.z > 0.0 )
				planar.x = 4.0 - v.x;
		} else if ( absV.x >= almostOne ) {
			float signX = sign( v.x );
			planar.x = v.z * signX + 2.0 * signX;
		} else if ( absV.y >= almostOne ) {
			float signY = sign( v.y );
			planar.x = v.x + 2.0 * signY + 2.0;
			planar.y = v.z * signY - 2.0;
		}
		return vec2( 0.125, 0.25 ) * planar + vec2( 0.375, 0.75 );
	}
	float getPointShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		
		float lightToPositionLength = length( lightToPosition );
		if ( lightToPositionLength - shadowCameraFar <= 0.0 && lightToPositionLength - shadowCameraNear >= 0.0 ) {
			float dp = ( lightToPositionLength - shadowCameraNear ) / ( shadowCameraFar - shadowCameraNear );			dp += shadowBias;
			vec3 bd3D = normalize( lightToPosition );
			vec2 texelSize = vec2( 1.0 ) / ( shadowMapSize * vec2( 4.0, 2.0 ) );
			#if defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_PCF_SOFT ) || defined( SHADOWMAP_TYPE_VSM )
				vec2 offset = vec2( - 1, 1 ) * shadowRadius * texelSize.y;
				shadow = (
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyy, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyy, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyx, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyx, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxy, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxy, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxx, texelSize.y ), dp ) +
					texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxx, texelSize.y ), dp )
				) * ( 1.0 / 9.0 );
			#else
				shadow = texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp );
			#endif
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
#endif`,B0=`#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
#endif`,z0=`#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0 );
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		#if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
			shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
		#endif
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif`,k0=`float getShadowMask() {
	float shadow = 1.0;
	#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLight = directionalLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		spotLight = spotLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowIntensity, spotLight.shadowBias, spotLight.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		pointLight = pointLightShadows[ i ];
		shadow *= receiveShadow ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowIntensity, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ], pointLight.shadowCameraNear, pointLight.shadowCameraFar ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#endif
	return shadow;
}`,H0=`#ifdef USE_SKINNING
	mat4 boneMatX = getBoneMatrix( skinIndex.x );
	mat4 boneMatY = getBoneMatrix( skinIndex.y );
	mat4 boneMatZ = getBoneMatrix( skinIndex.z );
	mat4 boneMatW = getBoneMatrix( skinIndex.w );
#endif`,V0=`#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	mat4 getBoneMatrix( const in float i ) {
		int size = textureSize( boneTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,G0=`#ifdef USE_SKINNING
	vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
	vec4 skinned = vec4( 0.0 );
	skinned += boneMatX * skinVertex * skinWeight.x;
	skinned += boneMatY * skinVertex * skinWeight.y;
	skinned += boneMatZ * skinVertex * skinWeight.z;
	skinned += boneMatW * skinVertex * skinWeight.w;
	transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`,W0=`#ifdef USE_SKINNING
	mat4 skinMatrix = mat4( 0.0 );
	skinMatrix += skinWeight.x * boneMatX;
	skinMatrix += skinWeight.y * boneMatY;
	skinMatrix += skinWeight.z * boneMatZ;
	skinMatrix += skinWeight.w * boneMatW;
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
	objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
#endif`,X0=`float specularStrength;
#ifdef USE_SPECULARMAP
	vec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );
	specularStrength = texelSpecular.r;
#else
	specularStrength = 1.0;
#endif`,q0=`#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif`,Y0=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`,j0=`#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
uniform float toneMappingExposure;
vec3 LinearToneMapping( vec3 color ) {
	return saturate( toneMappingExposure * color );
}
vec3 ReinhardToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( color / ( vec3( 1.0 ) + color ) );
}
vec3 CineonToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	color = max( vec3( 0.0 ), color - 0.004 );
	return pow( ( color * ( 6.2 * color + 0.5 ) ) / ( color * ( 6.2 * color + 1.7 ) + 0.06 ), vec3( 2.2 ) );
}
vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color *= toneMappingExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return saturate( color );
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
	vec3( 1.6605, - 0.1246, - 0.0182 ),
	vec3( - 0.5876, 1.1329, - 0.1006 ),
	vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 )
);
vec3 agxDefaultContrastApprox( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2
		- 40.14 * x4 * x
		+ 31.96 * x4
		- 6.868 * x2 * x
		+ 0.4298 * x2
		+ 0.1191 * x
		- 0.00232;
}
vec3 AgXToneMapping( vec3 color ) {
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
	);
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
	);
	const float AgxMinEv = - 12.47393;	const float AgxMaxEv = 4.026069;
	color *= toneMappingExposure;
	color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );	color = log2( color );
	color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
	color = clamp( color, 0.0, 1.0 );
	color = agxDefaultContrastApprox( color );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
	color = clamp( color, 0.0, 1.0 );
	return color;
}
vec3 NeutralToneMapping( vec3 color ) {
	const float StartCompression = 0.8 - 0.04;
	const float Desaturation = 0.15;
	color *= toneMappingExposure;
	float x = min( color.r, min( color.g, color.b ) );
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak < StartCompression ) return color;
	float d = 1. - StartCompression;
	float newPeak = 1. - d * d / ( peak + d - StartCompression );
	color *= newPeak / peak;
	float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
	return mix( color, vec3( newPeak ), g );
}
vec3 CustomToneMapping( vec3 color ) { return color; }`,K0=`#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;
	#endif
	#ifdef USE_THICKNESSMAP
		material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;
	#endif
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = inverseTransformDirection( normal, viewMatrix );
	vec4 transmitted = getIBLVolumeRefraction(
		n, v, material.roughness, material.diffuseColor, material.specularColor, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.dispersion, material.ior, material.thickness,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif`,$0=`#ifdef USE_TRANSMISSION
	uniform float transmission;
	uniform float thickness;
	uniform float attenuationDistance;
	uniform vec3 attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		uniform sampler2D transmissionMap;
	#endif
	#ifdef USE_THICKNESSMAP
		uniform sampler2D thicknessMap;
	#endif
	uniform vec2 transmissionSamplerSize;
	uniform sampler2D transmissionSamplerMap;
	uniform mat4 modelMatrix;
	uniform mat4 projectionMatrix;
	varying vec3 vWorldPosition;
	float w0( float a ) {
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - a + 3.0 ) - 3.0 ) + 1.0 );
	}
	float w1( float a ) {
		return ( 1.0 / 6.0 ) * ( a *  a * ( 3.0 * a - 6.0 ) + 4.0 );
	}
	float w2( float a ){
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - 3.0 * a + 3.0 ) + 3.0 ) + 1.0 );
	}
	float w3( float a ) {
		return ( 1.0 / 6.0 ) * ( a * a * a );
	}
	float g0( float a ) {
		return w0( a ) + w1( a );
	}
	float g1( float a ) {
		return w2( a ) + w3( a );
	}
	float h0( float a ) {
		return - 1.0 + w1( a ) / ( w0( a ) + w1( a ) );
	}
	float h1( float a ) {
		return 1.0 + w3( a ) / ( w2( a ) + w3( a ) );
	}
	vec4 bicubic( sampler2D tex, vec2 uv, vec4 texelSize, float lod ) {
		uv = uv * texelSize.zw + 0.5;
		vec2 iuv = floor( uv );
		vec2 fuv = fract( uv );
		float g0x = g0( fuv.x );
		float g1x = g1( fuv.x );
		float h0x = h0( fuv.x );
		float h1x = h1( fuv.x );
		float h0y = h0( fuv.y );
		float h1y = h1( fuv.y );
		vec2 p0 = ( vec2( iuv.x + h0x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p1 = ( vec2( iuv.x + h1x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p2 = ( vec2( iuv.x + h0x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		vec2 p3 = ( vec2( iuv.x + h1x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		return g0( fuv.y ) * ( g0x * textureLod( tex, p0, lod ) + g1x * textureLod( tex, p1, lod ) ) +
			g1( fuv.y ) * ( g0x * textureLod( tex, p2, lod ) + g1x * textureLod( tex, p3, lod ) );
	}
	vec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {
		vec2 fLodSize = vec2( textureSize( sampler, int( lod ) ) );
		vec2 cLodSize = vec2( textureSize( sampler, int( lod + 1.0 ) ) );
		vec2 fLodSizeInv = 1.0 / fLodSize;
		vec2 cLodSizeInv = 1.0 / cLodSize;
		vec4 fSample = bicubic( sampler, uv, vec4( fLodSizeInv, fLodSize ), floor( lod ) );
		vec4 cSample = bicubic( sampler, uv, vec4( cLodSizeInv, cLodSize ), ceil( lod ) );
		return mix( fSample, cSample, fract( lod ) );
	}
	vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix ) {
		vec3 refractionVector = refract( - v, normalize( n ), 1.0 / ior );
		vec3 modelScale;
		modelScale.x = length( vec3( modelMatrix[ 0 ].xyz ) );
		modelScale.y = length( vec3( modelMatrix[ 1 ].xyz ) );
		modelScale.z = length( vec3( modelMatrix[ 2 ].xyz ) );
		return normalize( refractionVector ) * thickness * modelScale;
	}
	float applyIorToRoughness( const in float roughness, const in float ior ) {
		return roughness * clamp( ior * 2.0 - 2.0, 0.0, 1.0 );
	}
	vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {
		float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );
		return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
	}
	vec3 volumeAttenuation( const in float transmissionDistance, const in vec3 attenuationColor, const in float attenuationDistance ) {
		if ( isinf( attenuationDistance ) ) {
			return vec3( 1.0 );
		} else {
			vec3 attenuationCoefficient = -log( attenuationColor ) / attenuationDistance;
			vec3 transmittance = exp( - attenuationCoefficient * transmissionDistance );			return transmittance;
		}
	}
	vec4 getIBLVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
		const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
		const in mat4 viewMatrix, const in mat4 projMatrix, const in float dispersion, const in float ior, const in float thickness,
		const in vec3 attenuationColor, const in float attenuationDistance ) {
		vec4 transmittedLight;
		vec3 transmittance;
		#ifdef USE_DISPERSION
			float halfSpread = ( ior - 1.0 ) * 0.025 * dispersion;
			vec3 iors = vec3( ior - halfSpread, ior, ior + halfSpread );
			for ( int i = 0; i < 3; i ++ ) {
				vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, iors[ i ], modelMatrix );
				vec3 refractedRayExit = position + transmissionRay;
		
				vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
				vec2 refractionCoords = ndcPos.xy / ndcPos.w;
				refractionCoords += 1.0;
				refractionCoords /= 2.0;
		
				vec4 transmissionSample = getTransmissionSample( refractionCoords, roughness, iors[ i ] );
				transmittedLight[ i ] = transmissionSample[ i ];
				transmittedLight.a += transmissionSample.a;
				transmittance[ i ] = diffuseColor[ i ] * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance )[ i ];
			}
			transmittedLight.a /= 3.0;
		
		#else
		
			vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, ior, modelMatrix );
			vec3 refractedRayExit = position + transmissionRay;
			vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
			vec2 refractionCoords = ndcPos.xy / ndcPos.w;
			refractionCoords += 1.0;
			refractionCoords /= 2.0;
			transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );
			transmittance = diffuseColor * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance );
		
		#endif
		vec3 attenuatedColor = transmittance * transmittedLight.rgb;
		vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
		float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
		return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
	}
#endif`,Z0=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_SPECULARMAP
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,J0=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	uniform mat3 mapTransform;
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	uniform mat3 alphaMapTransform;
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	uniform mat3 lightMapTransform;
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	uniform mat3 aoMapTransform;
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	uniform mat3 bumpMapTransform;
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	uniform mat3 normalMapTransform;
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_DISPLACEMENTMAP
	uniform mat3 displacementMapTransform;
	varying vec2 vDisplacementMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	uniform mat3 emissiveMapTransform;
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	uniform mat3 metalnessMapTransform;
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	uniform mat3 roughnessMapTransform;
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	uniform mat3 anisotropyMapTransform;
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	uniform mat3 clearcoatMapTransform;
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform mat3 clearcoatNormalMapTransform;
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform mat3 clearcoatRoughnessMapTransform;
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	uniform mat3 sheenColorMapTransform;
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	uniform mat3 sheenRoughnessMapTransform;
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	uniform mat3 iridescenceMapTransform;
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform mat3 iridescenceThicknessMapTransform;
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SPECULARMAP
	uniform mat3 specularMapTransform;
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	uniform mat3 specularColorMapTransform;
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	uniform mat3 specularIntensityMapTransform;
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Q0=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	vUv = vec3( uv, 1 ).xy;
#endif
#ifdef USE_MAP
	vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ALPHAMAP
	vAlphaMapUv = ( alphaMapTransform * vec3( ALPHAMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_LIGHTMAP
	vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_AOMAP
	vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = ( bumpMapTransform * vec3( BUMPMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_DISPLACEMENTMAP
	vDisplacementMapUv = ( displacementMapTransform * vec3( DISPLACEMENTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_EMISSIVEMAP
	vEmissiveMapUv = ( emissiveMapTransform * vec3( EMISSIVEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
	vMetalnessMapUv = ( metalnessMapTransform * vec3( METALNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ANISOTROPYMAP
	vAnisotropyMapUv = ( anisotropyMapTransform * vec3( ANISOTROPYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOATMAP
	vClearcoatMapUv = ( clearcoatMapTransform * vec3( CLEARCOATMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	vClearcoatNormalMapUv = ( clearcoatNormalMapTransform * vec3( CLEARCOAT_NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	vClearcoatRoughnessMapUv = ( clearcoatRoughnessMapTransform * vec3( CLEARCOAT_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCEMAP
	vIridescenceMapUv = ( iridescenceMapTransform * vec3( IRIDESCENCEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	vIridescenceThicknessMapUv = ( iridescenceThicknessMapTransform * vec3( IRIDESCENCE_THICKNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_COLORMAP
	vSheenColorMapUv = ( sheenColorMapTransform * vec3( SHEEN_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	vSheenRoughnessMapUv = ( sheenRoughnessMapTransform * vec3( SHEEN_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULARMAP
	vSpecularMapUv = ( specularMapTransform * vec3( SPECULARMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_COLORMAP
	vSpecularColorMapUv = ( specularColorMapTransform * vec3( SPECULAR_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	vSpecularIntensityMapUv = ( specularIntensityMapTransform * vec3( SPECULAR_INTENSITYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_TRANSMISSIONMAP
	vTransmissionMapUv = ( transmissionMapTransform * vec3( TRANSMISSIONMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_THICKNESSMAP
	vThicknessMapUv = ( thicknessMapTransform * vec3( THICKNESSMAP_UV, 1 ) ).xy;
#endif`,tx=`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
#endif`;const ex=`varying vec2 vUv;
uniform mat3 uvTransform;
void main() {
	vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}`,nx=`uniform sampler2D t2D;
uniform float backgroundIntensity;
varying vec2 vUv;
void main() {
	vec4 texColor = texture2D( t2D, vUv );
	#ifdef DECODE_VIDEO_TEXTURE
		texColor = vec4( mix( pow( texColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), texColor.rgb * 0.0773993808, vec3( lessThanEqual( texColor.rgb, vec3( 0.04045 ) ) ) ), texColor.w );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,ix=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,sx=`#ifdef ENVMAP_TYPE_CUBE
	uniform samplerCube envMap;
#elif defined( ENVMAP_TYPE_CUBE_UV )
	uniform sampler2D envMap;
#endif
uniform float flipEnvMap;
uniform float backgroundBlurriness;
uniform float backgroundIntensity;
uniform mat3 backgroundRotation;
varying vec3 vWorldDirection;
#include <cube_uv_reflection_fragment>
void main() {
	#ifdef ENVMAP_TYPE_CUBE
		vec4 texColor = textureCube( envMap, backgroundRotation * vec3( flipEnvMap * vWorldDirection.x, vWorldDirection.yz ) );
	#elif defined( ENVMAP_TYPE_CUBE_UV )
		vec4 texColor = textureCubeUV( envMap, backgroundRotation * vWorldDirection, backgroundBlurriness );
	#else
		vec4 texColor = vec4( 0.0, 0.0, 0.0, 1.0 );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,rx=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,ox=`uniform samplerCube tCube;
uniform float tFlip;
uniform float opacity;
varying vec3 vWorldDirection;
void main() {
	vec4 texColor = textureCube( tCube, vec3( tFlip * vWorldDirection.x, vWorldDirection.yz ) );
	gl_FragColor = texColor;
	gl_FragColor.a *= opacity;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,ax=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vHighPrecisionZW;
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vHighPrecisionZW = gl_Position.zw;
}`,lx=`#if DEPTH_PACKING == 3200
	uniform float opacity;
#endif
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec2 vHighPrecisionZW;
void main() {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#if DEPTH_PACKING == 3200
		diffuseColor.a = opacity;
	#endif
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <logdepthbuf_fragment>
	float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
	#if DEPTH_PACKING == 3200
		gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );
	#elif DEPTH_PACKING == 3201
		gl_FragColor = packDepthToRGBA( fragCoordZ );
	#elif DEPTH_PACKING == 3202
		gl_FragColor = vec4( packDepthToRGB( fragCoordZ ), 1.0 );
	#elif DEPTH_PACKING == 3203
		gl_FragColor = vec4( packDepthToRG( fragCoordZ ), 0.0, 1.0 );
	#endif
}`,cx=`#define DISTANCE
varying vec3 vWorldPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#include <morphinstance_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <worldpos_vertex>
	#include <clipping_planes_vertex>
	vWorldPosition = worldPosition.xyz;
}`,ux=`#define DISTANCE
uniform vec3 referencePosition;
uniform float nearDistance;
uniform float farDistance;
varying vec3 vWorldPosition;
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <clipping_planes_pars_fragment>
void main () {
	vec4 diffuseColor = vec4( 1.0 );
	#include <clipping_planes_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	float dist = length( vWorldPosition - referencePosition );
	dist = ( dist - nearDistance ) / ( farDistance - nearDistance );
	dist = saturate( dist );
	gl_FragColor = packDepthToRGBA( dist );
}`,hx=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
}`,fx=`uniform sampler2D tEquirect;
varying vec3 vWorldDirection;
#include <common>
void main() {
	vec3 direction = normalize( vWorldDirection );
	vec2 sampleUV = equirectUv( direction );
	gl_FragColor = texture2D( tEquirect, sampleUV );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,dx=`uniform float scale;
attribute float lineDistance;
varying float vLineDistance;
#include <common>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	vLineDistance = scale * lineDistance;
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,px=`uniform vec3 diffuse;
uniform float opacity;
uniform float dashSize;
uniform float totalSize;
varying float vLineDistance;
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	if ( mod( vLineDistance, totalSize ) > dashSize ) {
		discard;
	}
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,mx=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <fog_vertex>
}`,_x=`uniform vec3 diffuse;
uniform float opacity;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
	#else
		reflectedLight.indirectDiffuse += vec3( 1.0 );
	#endif
	#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= diffuseColor.rgb;
	vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,gx=`#define LAMBERT
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,vx=`#define LAMBERT
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_lambert_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,xx=`#define MATCAP
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
	vViewPosition = - mvPosition.xyz;
}`,yx=`#define MATCAP
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D matcap;
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	vec3 viewDir = normalize( vViewPosition );
	vec3 x = normalize( vec3( viewDir.z, 0.0, - viewDir.x ) );
	vec3 y = cross( viewDir, x );
	vec2 uv = vec2( dot( x, normal ), dot( y, normal ) ) * 0.495 + 0.5;
	#ifdef USE_MATCAP
		vec4 matcapColor = texture2D( matcap, uv );
	#else
		vec4 matcapColor = vec4( vec3( mix( 0.2, 0.8, uv.y ) ), 1.0 );
	#endif
	vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,Mx=`#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	vViewPosition = - mvPosition.xyz;
#endif
}`,Sx=`#define NORMAL
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <packing>
#include <uv_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( 0.0, 0.0, 0.0, opacity );
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	gl_FragColor = vec4( packNormalToRGB( normal ), diffuseColor.a );
	#ifdef OPAQUE
		gl_FragColor.a = 1.0;
	#endif
}`,Ex=`#define PHONG
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,bx=`#define PHONG
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,Tx=`#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
	varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
#ifdef USE_TRANSMISSION
	vWorldPosition = worldPosition.xyz;
#endif
}`,Ax=`#define STANDARD
#ifdef PHYSICAL
	#define IOR
	#define USE_SPECULAR
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;
#ifdef IOR
	uniform float ior;
#endif
#ifdef USE_SPECULAR
	uniform float specularIntensity;
	uniform vec3 specularColor;
	#ifdef USE_SPECULAR_COLORMAP
		uniform sampler2D specularColorMap;
	#endif
	#ifdef USE_SPECULAR_INTENSITYMAP
		uniform sampler2D specularIntensityMap;
	#endif
#endif
#ifdef USE_CLEARCOAT
	uniform float clearcoat;
	uniform float clearcoatRoughness;
#endif
#ifdef USE_DISPERSION
	uniform float dispersion;
#endif
#ifdef USE_IRIDESCENCE
	uniform float iridescence;
	uniform float iridescenceIOR;
	uniform float iridescenceThicknessMinimum;
	uniform float iridescenceThicknessMaximum;
#endif
#ifdef USE_SHEEN
	uniform vec3 sheenColor;
	uniform float sheenRoughness;
	#ifdef USE_SHEEN_COLORMAP
		uniform sampler2D sheenColorMap;
	#endif
	#ifdef USE_SHEEN_ROUGHNESSMAP
		uniform sampler2D sheenRoughnessMap;
	#endif
#endif
#ifdef USE_ANISOTROPY
	uniform vec2 anisotropyVector;
	#ifdef USE_ANISOTROPYMAP
		uniform sampler2D anisotropyMap;
	#endif
#endif
varying vec3 vViewPosition;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <iridescence_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_physical_pars_fragment>
#include <transmission_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <clearcoat_pars_fragment>
#include <iridescence_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	#include <clearcoat_normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	#include <transmission_fragment>
	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
	#ifdef USE_SHEEN
		float sheenEnergyComp = 1.0 - 0.157 * max3( material.sheenColor );
		outgoingLight = outgoingLight * sheenEnergyComp + sheenSpecularDirect + sheenSpecularIndirect;
	#endif
	#ifdef USE_CLEARCOAT
		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );
		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
	#endif
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,wx=`#define TOON
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,Rx=`#define TOON
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <gradientmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_toon_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_toon_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,Cx=`uniform float size;
uniform float scale;
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef USE_POINTS_UV
	varying vec2 vUv;
	uniform mat3 uvTransform;
#endif
void main() {
	#ifdef USE_POINTS_UV
		vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	#endif
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	gl_PointSize = size;
	#ifdef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
	#endif
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <fog_vertex>
}`,Px=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <color_pars_fragment>
#include <map_particle_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_particle_fragment>
	#include <color_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,Dx=`#include <common>
#include <batching_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphinstance_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,Lx=`uniform vec3 color;
uniform float opacity;
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,Ix=`uniform float rotation;
uniform vec2 center;
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	vec4 mvPosition = modelViewMatrix[ 3 ];
	vec2 scale = vec2( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ) );
	#ifndef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) scale *= - mvPosition.z;
	#endif
	vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
	vec2 rotatedPosition;
	rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
	rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
	mvPosition.xy += rotatedPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,Ux=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,Xt={alphahash_fragment:nv,alphahash_pars_fragment:iv,alphamap_fragment:sv,alphamap_pars_fragment:rv,alphatest_fragment:ov,alphatest_pars_fragment:av,aomap_fragment:lv,aomap_pars_fragment:cv,batching_pars_vertex:uv,batching_vertex:hv,begin_vertex:fv,beginnormal_vertex:dv,bsdfs:pv,iridescence_fragment:mv,bumpmap_pars_fragment:_v,clipping_planes_fragment:gv,clipping_planes_pars_fragment:vv,clipping_planes_pars_vertex:xv,clipping_planes_vertex:yv,color_fragment:Mv,color_pars_fragment:Sv,color_pars_vertex:Ev,color_vertex:bv,common:Tv,cube_uv_reflection_fragment:Av,defaultnormal_vertex:wv,displacementmap_pars_vertex:Rv,displacementmap_vertex:Cv,emissivemap_fragment:Pv,emissivemap_pars_fragment:Dv,colorspace_fragment:Lv,colorspace_pars_fragment:Iv,envmap_fragment:Uv,envmap_common_pars_fragment:Nv,envmap_pars_fragment:Ov,envmap_pars_vertex:Fv,envmap_physical_pars_fragment:jv,envmap_vertex:Bv,fog_vertex:zv,fog_pars_vertex:kv,fog_fragment:Hv,fog_pars_fragment:Vv,gradientmap_pars_fragment:Gv,lightmap_pars_fragment:Wv,lights_lambert_fragment:Xv,lights_lambert_pars_fragment:qv,lights_pars_begin:Yv,lights_toon_fragment:Kv,lights_toon_pars_fragment:$v,lights_phong_fragment:Zv,lights_phong_pars_fragment:Jv,lights_physical_fragment:Qv,lights_physical_pars_fragment:t0,lights_fragment_begin:e0,lights_fragment_maps:n0,lights_fragment_end:i0,logdepthbuf_fragment:s0,logdepthbuf_pars_fragment:r0,logdepthbuf_pars_vertex:o0,logdepthbuf_vertex:a0,map_fragment:l0,map_pars_fragment:c0,map_particle_fragment:u0,map_particle_pars_fragment:h0,metalnessmap_fragment:f0,metalnessmap_pars_fragment:d0,morphinstance_vertex:p0,morphcolor_vertex:m0,morphnormal_vertex:_0,morphtarget_pars_vertex:g0,morphtarget_vertex:v0,normal_fragment_begin:x0,normal_fragment_maps:y0,normal_pars_fragment:M0,normal_pars_vertex:S0,normal_vertex:E0,normalmap_pars_fragment:b0,clearcoat_normal_fragment_begin:T0,clearcoat_normal_fragment_maps:A0,clearcoat_pars_fragment:w0,iridescence_pars_fragment:R0,opaque_fragment:C0,packing:P0,premultiplied_alpha_fragment:D0,project_vertex:L0,dithering_fragment:I0,dithering_pars_fragment:U0,roughnessmap_fragment:N0,roughnessmap_pars_fragment:O0,shadowmap_pars_fragment:F0,shadowmap_pars_vertex:B0,shadowmap_vertex:z0,shadowmask_pars_fragment:k0,skinbase_vertex:H0,skinning_pars_vertex:V0,skinning_vertex:G0,skinnormal_vertex:W0,specularmap_fragment:X0,specularmap_pars_fragment:q0,tonemapping_fragment:Y0,tonemapping_pars_fragment:j0,transmission_fragment:K0,transmission_pars_fragment:$0,uv_pars_fragment:Z0,uv_pars_vertex:J0,uv_vertex:Q0,worldpos_vertex:tx,background_vert:ex,background_frag:nx,backgroundCube_vert:ix,backgroundCube_frag:sx,cube_vert:rx,cube_frag:ox,depth_vert:ax,depth_frag:lx,distanceRGBA_vert:cx,distanceRGBA_frag:ux,equirect_vert:hx,equirect_frag:fx,linedashed_vert:dx,linedashed_frag:px,meshbasic_vert:mx,meshbasic_frag:_x,meshlambert_vert:gx,meshlambert_frag:vx,meshmatcap_vert:xx,meshmatcap_frag:yx,meshnormal_vert:Mx,meshnormal_frag:Sx,meshphong_vert:Ex,meshphong_frag:bx,meshphysical_vert:Tx,meshphysical_frag:Ax,meshtoon_vert:wx,meshtoon_frag:Rx,points_vert:Cx,points_frag:Px,shadow_vert:Dx,shadow_frag:Lx,sprite_vert:Ix,sprite_frag:Ux},_t={common:{diffuse:{value:new $t(16777215)},opacity:{value:1},map:{value:null},mapTransform:{value:new Wt},alphaMap:{value:null},alphaMapTransform:{value:new Wt},alphaTest:{value:0}},specularmap:{specularMap:{value:null},specularMapTransform:{value:new Wt}},envmap:{envMap:{value:null},envMapRotation:{value:new Wt},flipEnvMap:{value:-1},reflectivity:{value:1},ior:{value:1.5},refractionRatio:{value:.98}},aomap:{aoMap:{value:null},aoMapIntensity:{value:1},aoMapTransform:{value:new Wt}},lightmap:{lightMap:{value:null},lightMapIntensity:{value:1},lightMapTransform:{value:new Wt}},bumpmap:{bumpMap:{value:null},bumpMapTransform:{value:new Wt},bumpScale:{value:1}},normalmap:{normalMap:{value:null},normalMapTransform:{value:new Wt},normalScale:{value:new kt(1,1)}},displacementmap:{displacementMap:{value:null},displacementMapTransform:{value:new Wt},displacementScale:{value:1},displacementBias:{value:0}},emissivemap:{emissiveMap:{value:null},emissiveMapTransform:{value:new Wt}},metalnessmap:{metalnessMap:{value:null},metalnessMapTransform:{value:new Wt}},roughnessmap:{roughnessMap:{value:null},roughnessMapTransform:{value:new Wt}},gradientmap:{gradientMap:{value:null}},fog:{fogDensity:{value:25e-5},fogNear:{value:1},fogFar:{value:2e3},fogColor:{value:new $t(16777215)}},lights:{ambientLightColor:{value:[]},lightProbe:{value:[]},directionalLights:{value:[],properties:{direction:{},color:{}}},directionalLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},directionalShadowMap:{value:[]},directionalShadowMatrix:{value:[]},spotLights:{value:[],properties:{color:{},position:{},direction:{},distance:{},coneCos:{},penumbraCos:{},decay:{}}},spotLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},spotLightMap:{value:[]},spotShadowMap:{value:[]},spotLightMatrix:{value:[]},pointLights:{value:[],properties:{color:{},position:{},decay:{},distance:{}}},pointLightShadows:{value:[],properties:{shadowIntensity:1,shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{},shadowCameraNear:{},shadowCameraFar:{}}},pointShadowMap:{value:[]},pointShadowMatrix:{value:[]},hemisphereLights:{value:[],properties:{direction:{},skyColor:{},groundColor:{}}},rectAreaLights:{value:[],properties:{color:{},position:{},width:{},height:{}}},ltc_1:{value:null},ltc_2:{value:null}},points:{diffuse:{value:new $t(16777215)},opacity:{value:1},size:{value:1},scale:{value:1},map:{value:null},alphaMap:{value:null},alphaMapTransform:{value:new Wt},alphaTest:{value:0},uvTransform:{value:new Wt}},sprite:{diffuse:{value:new $t(16777215)},opacity:{value:1},center:{value:new kt(.5,.5)},rotation:{value:0},map:{value:null},mapTransform:{value:new Wt},alphaMap:{value:null},alphaMapTransform:{value:new Wt},alphaTest:{value:0}}},Dn={basic:{uniforms:Ne([_t.common,_t.specularmap,_t.envmap,_t.aomap,_t.lightmap,_t.fog]),vertexShader:Xt.meshbasic_vert,fragmentShader:Xt.meshbasic_frag},lambert:{uniforms:Ne([_t.common,_t.specularmap,_t.envmap,_t.aomap,_t.lightmap,_t.emissivemap,_t.bumpmap,_t.normalmap,_t.displacementmap,_t.fog,_t.lights,{emissive:{value:new $t(0)}}]),vertexShader:Xt.meshlambert_vert,fragmentShader:Xt.meshlambert_frag},phong:{uniforms:Ne([_t.common,_t.specularmap,_t.envmap,_t.aomap,_t.lightmap,_t.emissivemap,_t.bumpmap,_t.normalmap,_t.displacementmap,_t.fog,_t.lights,{emissive:{value:new $t(0)},specular:{value:new $t(1118481)},shininess:{value:30}}]),vertexShader:Xt.meshphong_vert,fragmentShader:Xt.meshphong_frag},standard:{uniforms:Ne([_t.common,_t.envmap,_t.aomap,_t.lightmap,_t.emissivemap,_t.bumpmap,_t.normalmap,_t.displacementmap,_t.roughnessmap,_t.metalnessmap,_t.fog,_t.lights,{emissive:{value:new $t(0)},roughness:{value:1},metalness:{value:0},envMapIntensity:{value:1}}]),vertexShader:Xt.meshphysical_vert,fragmentShader:Xt.meshphysical_frag},toon:{uniforms:Ne([_t.common,_t.aomap,_t.lightmap,_t.emissivemap,_t.bumpmap,_t.normalmap,_t.displacementmap,_t.gradientmap,_t.fog,_t.lights,{emissive:{value:new $t(0)}}]),vertexShader:Xt.meshtoon_vert,fragmentShader:Xt.meshtoon_frag},matcap:{uniforms:Ne([_t.common,_t.bumpmap,_t.normalmap,_t.displacementmap,_t.fog,{matcap:{value:null}}]),vertexShader:Xt.meshmatcap_vert,fragmentShader:Xt.meshmatcap_frag},points:{uniforms:Ne([_t.points,_t.fog]),vertexShader:Xt.points_vert,fragmentShader:Xt.points_frag},dashed:{uniforms:Ne([_t.common,_t.fog,{scale:{value:1},dashSize:{value:1},totalSize:{value:2}}]),vertexShader:Xt.linedashed_vert,fragmentShader:Xt.linedashed_frag},depth:{uniforms:Ne([_t.common,_t.displacementmap]),vertexShader:Xt.depth_vert,fragmentShader:Xt.depth_frag},normal:{uniforms:Ne([_t.common,_t.bumpmap,_t.normalmap,_t.displacementmap,{opacity:{value:1}}]),vertexShader:Xt.meshnormal_vert,fragmentShader:Xt.meshnormal_frag},sprite:{uniforms:Ne([_t.sprite,_t.fog]),vertexShader:Xt.sprite_vert,fragmentShader:Xt.sprite_frag},background:{uniforms:{uvTransform:{value:new Wt},t2D:{value:null},backgroundIntensity:{value:1}},vertexShader:Xt.background_vert,fragmentShader:Xt.background_frag},backgroundCube:{uniforms:{envMap:{value:null},flipEnvMap:{value:-1},backgroundBlurriness:{value:0},backgroundIntensity:{value:1},backgroundRotation:{value:new Wt}},vertexShader:Xt.backgroundCube_vert,fragmentShader:Xt.backgroundCube_frag},cube:{uniforms:{tCube:{value:null},tFlip:{value:-1},opacity:{value:1}},vertexShader:Xt.cube_vert,fragmentShader:Xt.cube_frag},equirect:{uniforms:{tEquirect:{value:null}},vertexShader:Xt.equirect_vert,fragmentShader:Xt.equirect_frag},distanceRGBA:{uniforms:Ne([_t.common,_t.displacementmap,{referencePosition:{value:new G},nearDistance:{value:1},farDistance:{value:1e3}}]),vertexShader:Xt.distanceRGBA_vert,fragmentShader:Xt.distanceRGBA_frag},shadow:{uniforms:Ne([_t.lights,_t.fog,{color:{value:new $t(0)},opacity:{value:1}}]),vertexShader:Xt.shadow_vert,fragmentShader:Xt.shadow_frag}};Dn.physical={uniforms:Ne([Dn.standard.uniforms,{clearcoat:{value:0},clearcoatMap:{value:null},clearcoatMapTransform:{value:new Wt},clearcoatNormalMap:{value:null},clearcoatNormalMapTransform:{value:new Wt},clearcoatNormalScale:{value:new kt(1,1)},clearcoatRoughness:{value:0},clearcoatRoughnessMap:{value:null},clearcoatRoughnessMapTransform:{value:new Wt},dispersion:{value:0},iridescence:{value:0},iridescenceMap:{value:null},iridescenceMapTransform:{value:new Wt},iridescenceIOR:{value:1.3},iridescenceThicknessMinimum:{value:100},iridescenceThicknessMaximum:{value:400},iridescenceThicknessMap:{value:null},iridescenceThicknessMapTransform:{value:new Wt},sheen:{value:0},sheenColor:{value:new $t(0)},sheenColorMap:{value:null},sheenColorMapTransform:{value:new Wt},sheenRoughness:{value:1},sheenRoughnessMap:{value:null},sheenRoughnessMapTransform:{value:new Wt},transmission:{value:0},transmissionMap:{value:null},transmissionMapTransform:{value:new Wt},transmissionSamplerSize:{value:new kt},transmissionSamplerMap:{value:null},thickness:{value:0},thicknessMap:{value:null},thicknessMapTransform:{value:new Wt},attenuationDistance:{value:0},attenuationColor:{value:new $t(0)},specularColor:{value:new $t(1,1,1)},specularColorMap:{value:null},specularColorMapTransform:{value:new Wt},specularIntensity:{value:1},specularIntensityMap:{value:null},specularIntensityMapTransform:{value:new Wt},anisotropyVector:{value:new kt},anisotropyMap:{value:null},anisotropyMapTransform:{value:new Wt}}]),vertexShader:Xt.meshphysical_vert,fragmentShader:Xt.meshphysical_frag};const ro={r:0,b:0,g:0},Hi=new Gn,Nx=new ue;function Ox(n,t,e,i,s,r,o){const a=new $t(0);let l=r===!0?0:1,u,c,h=null,d=0,p=null;function g(w){let b=w.isScene===!0?w.background:null;return b&&b.isTexture&&(b=(w.backgroundBlurriness>0?e:t).get(b)),b}function v(w){let b=!1;const x=g(w);x===null?f(a,l):x&&x.isColor&&(f(x,1),b=!0);const B=n.xr.getEnvironmentBlendMode();B==="additive"?i.buffers.color.setClear(0,0,0,1,o):B==="alpha-blend"&&i.buffers.color.setClear(0,0,0,0,o),(n.autoClear||b)&&(i.buffers.depth.setTest(!0),i.buffers.depth.setMask(!0),i.buffers.color.setMask(!0),n.clear(n.autoClearColor,n.autoClearDepth,n.autoClearStencil))}function m(w,b){const x=g(b);x&&(x.isCubeTexture||x.mapping===na)?(c===void 0&&(c=new qe(new is(1,1,1),new Li({name:"BackgroundCubeMaterial",uniforms:ks(Dn.backgroundCube.uniforms),vertexShader:Dn.backgroundCube.vertexShader,fragmentShader:Dn.backgroundCube.fragmentShader,side:Ye,depthTest:!1,depthWrite:!1,fog:!1})),c.geometry.deleteAttribute("normal"),c.geometry.deleteAttribute("uv"),c.onBeforeRender=function(B,P,D){this.matrixWorld.copyPosition(D.matrixWorld)},Object.defineProperty(c.material,"envMap",{get:function(){return this.uniforms.envMap.value}}),s.update(c)),Hi.copy(b.backgroundRotation),Hi.x*=-1,Hi.y*=-1,Hi.z*=-1,x.isCubeTexture&&x.isRenderTargetTexture===!1&&(Hi.y*=-1,Hi.z*=-1),c.material.uniforms.envMap.value=x,c.material.uniforms.flipEnvMap.value=x.isCubeTexture&&x.isRenderTargetTexture===!1?-1:1,c.material.uniforms.backgroundBlurriness.value=b.backgroundBlurriness,c.material.uniforms.backgroundIntensity.value=b.backgroundIntensity,c.material.uniforms.backgroundRotation.value.setFromMatrix4(Nx.makeRotationFromEuler(Hi)),c.material.toneMapped=Jt.getTransfer(x.colorSpace)!==ae,(h!==x||d!==x.version||p!==n.toneMapping)&&(c.material.needsUpdate=!0,h=x,d=x.version,p=n.toneMapping),c.layers.enableAll(),w.unshift(c,c.geometry,c.material,0,0,null)):x&&x.isTexture&&(u===void 0&&(u=new qe(new sa(2,2),new Li({name:"BackgroundMaterial",uniforms:ks(Dn.background.uniforms),vertexShader:Dn.background.vertexShader,fragmentShader:Dn.background.fragmentShader,side:Pi,depthTest:!1,depthWrite:!1,fog:!1})),u.geometry.deleteAttribute("normal"),Object.defineProperty(u.material,"map",{get:function(){return this.uniforms.t2D.value}}),s.update(u)),u.material.uniforms.t2D.value=x,u.material.uniforms.backgroundIntensity.value=b.backgroundIntensity,u.material.toneMapped=Jt.getTransfer(x.colorSpace)!==ae,x.matrixAutoUpdate===!0&&x.updateMatrix(),u.material.uniforms.uvTransform.value.copy(x.matrix),(h!==x||d!==x.version||p!==n.toneMapping)&&(u.material.needsUpdate=!0,h=x,d=x.version,p=n.toneMapping),u.layers.enableAll(),w.unshift(u,u.geometry,u.material,0,0,null))}function f(w,b){w.getRGB(ro,Od(n)),i.buffers.color.setClear(ro.r,ro.g,ro.b,b,o)}return{getClearColor:function(){return a},setClearColor:function(w,b=1){a.set(w),l=b,f(a,l)},getClearAlpha:function(){return l},setClearAlpha:function(w){l=w,f(a,l)},render:v,addToRenderList:m}}function Fx(n,t){const e=n.getParameter(n.MAX_VERTEX_ATTRIBS),i={},s=d(null);let r=s,o=!1;function a(M,L,J,C,k){let Y=!1;const H=h(C,J,L);r!==H&&(r=H,u(r.object)),Y=p(M,C,J,k),Y&&g(M,C,J,k),k!==null&&t.update(k,n.ELEMENT_ARRAY_BUFFER),(Y||o)&&(o=!1,x(M,L,J,C),k!==null&&n.bindBuffer(n.ELEMENT_ARRAY_BUFFER,t.get(k).buffer))}function l(){return n.createVertexArray()}function u(M){return n.bindVertexArray(M)}function c(M){return n.deleteVertexArray(M)}function h(M,L,J){const C=J.wireframe===!0;let k=i[M.id];k===void 0&&(k={},i[M.id]=k);let Y=k[L.id];Y===void 0&&(Y={},k[L.id]=Y);let H=Y[C];return H===void 0&&(H=d(l()),Y[C]=H),H}function d(M){const L=[],J=[],C=[];for(let k=0;k<e;k++)L[k]=0,J[k]=0,C[k]=0;return{geometry:null,program:null,wireframe:!1,newAttributes:L,enabledAttributes:J,attributeDivisors:C,object:M,attributes:{},index:null}}function p(M,L,J,C){const k=r.attributes,Y=L.attributes;let H=0;const q=J.getAttributes();for(const z in q)if(q[z].location>=0){const dt=k[z];let bt=Y[z];if(bt===void 0&&(z==="instanceMatrix"&&M.instanceMatrix&&(bt=M.instanceMatrix),z==="instanceColor"&&M.instanceColor&&(bt=M.instanceColor)),dt===void 0||dt.attribute!==bt||bt&&dt.data!==bt.data)return!0;H++}return r.attributesNum!==H||r.index!==C}function g(M,L,J,C){const k={},Y=L.attributes;let H=0;const q=J.getAttributes();for(const z in q)if(q[z].location>=0){let dt=Y[z];dt===void 0&&(z==="instanceMatrix"&&M.instanceMatrix&&(dt=M.instanceMatrix),z==="instanceColor"&&M.instanceColor&&(dt=M.instanceColor));const bt={};bt.attribute=dt,dt&&dt.data&&(bt.data=dt.data),k[z]=bt,H++}r.attributes=k,r.attributesNum=H,r.index=C}function v(){const M=r.newAttributes;for(let L=0,J=M.length;L<J;L++)M[L]=0}function m(M){f(M,0)}function f(M,L){const J=r.newAttributes,C=r.enabledAttributes,k=r.attributeDivisors;J[M]=1,C[M]===0&&(n.enableVertexAttribArray(M),C[M]=1),k[M]!==L&&(n.vertexAttribDivisor(M,L),k[M]=L)}function w(){const M=r.newAttributes,L=r.enabledAttributes;for(let J=0,C=L.length;J<C;J++)L[J]!==M[J]&&(n.disableVertexAttribArray(J),L[J]=0)}function b(M,L,J,C,k,Y,H){H===!0?n.vertexAttribIPointer(M,L,J,k,Y):n.vertexAttribPointer(M,L,J,C,k,Y)}function x(M,L,J,C){v();const k=C.attributes,Y=J.getAttributes(),H=L.defaultAttributeValues;for(const q in Y){const z=Y[q];if(z.location>=0){let at=k[q];if(at===void 0&&(q==="instanceMatrix"&&M.instanceMatrix&&(at=M.instanceMatrix),q==="instanceColor"&&M.instanceColor&&(at=M.instanceColor)),at!==void 0){const dt=at.normalized,bt=at.itemSize,Ut=t.get(at);if(Ut===void 0)continue;const ee=Ut.buffer,it=Ut.type,ut=Ut.bytesPerElement,Tt=it===n.INT||it===n.UNSIGNED_INT||at.gpuType===Pc;if(at.isInterleavedBufferAttribute){const mt=at.data,It=mt.stride,Nt=at.offset;if(mt.isInstancedInterleavedBuffer){for(let Yt=0;Yt<z.locationSize;Yt++)f(z.location+Yt,mt.meshPerAttribute);M.isInstancedMesh!==!0&&C._maxInstanceCount===void 0&&(C._maxInstanceCount=mt.meshPerAttribute*mt.count)}else for(let Yt=0;Yt<z.locationSize;Yt++)m(z.location+Yt);n.bindBuffer(n.ARRAY_BUFFER,ee);for(let Yt=0;Yt<z.locationSize;Yt++)b(z.location+Yt,bt/z.locationSize,it,dt,It*ut,(Nt+bt/z.locationSize*Yt)*ut,Tt)}else{if(at.isInstancedBufferAttribute){for(let mt=0;mt<z.locationSize;mt++)f(z.location+mt,at.meshPerAttribute);M.isInstancedMesh!==!0&&C._maxInstanceCount===void 0&&(C._maxInstanceCount=at.meshPerAttribute*at.count)}else for(let mt=0;mt<z.locationSize;mt++)m(z.location+mt);n.bindBuffer(n.ARRAY_BUFFER,ee);for(let mt=0;mt<z.locationSize;mt++)b(z.location+mt,bt/z.locationSize,it,dt,bt*ut,bt/z.locationSize*mt*ut,Tt)}}else if(H!==void 0){const dt=H[q];if(dt!==void 0)switch(dt.length){case 2:n.vertexAttrib2fv(z.location,dt);break;case 3:n.vertexAttrib3fv(z.location,dt);break;case 4:n.vertexAttrib4fv(z.location,dt);break;default:n.vertexAttrib1fv(z.location,dt)}}}}w()}function B(){N();for(const M in i){const L=i[M];for(const J in L){const C=L[J];for(const k in C)c(C[k].object),delete C[k];delete L[J]}delete i[M]}}function P(M){if(i[M.id]===void 0)return;const L=i[M.id];for(const J in L){const C=L[J];for(const k in C)c(C[k].object),delete C[k];delete L[J]}delete i[M.id]}function D(M){for(const L in i){const J=i[L];if(J[M.id]===void 0)continue;const C=J[M.id];for(const k in C)c(C[k].object),delete C[k];delete J[M.id]}}function N(){E(),o=!0,r!==s&&(r=s,u(r.object))}function E(){s.geometry=null,s.program=null,s.wireframe=!1}return{setup:a,reset:N,resetDefaultState:E,dispose:B,releaseStatesOfGeometry:P,releaseStatesOfProgram:D,initAttributes:v,enableAttribute:m,disableUnusedAttributes:w}}function Bx(n,t,e){let i;function s(u){i=u}function r(u,c){n.drawArrays(i,u,c),e.update(c,i,1)}function o(u,c,h){h!==0&&(n.drawArraysInstanced(i,u,c,h),e.update(c,i,h))}function a(u,c,h){if(h===0)return;t.get("WEBGL_multi_draw").multiDrawArraysWEBGL(i,u,0,c,0,h);let p=0;for(let g=0;g<h;g++)p+=c[g];e.update(p,i,1)}function l(u,c,h,d){if(h===0)return;const p=t.get("WEBGL_multi_draw");if(p===null)for(let g=0;g<u.length;g++)o(u[g],c[g],d[g]);else{p.multiDrawArraysInstancedWEBGL(i,u,0,c,0,d,0,h);let g=0;for(let v=0;v<h;v++)g+=c[v]*d[v];e.update(g,i,1)}}this.setMode=s,this.render=r,this.renderInstances=o,this.renderMultiDraw=a,this.renderMultiDrawInstances=l}function zx(n,t,e,i){let s;function r(){if(s!==void 0)return s;if(t.has("EXT_texture_filter_anisotropic")===!0){const D=t.get("EXT_texture_filter_anisotropic");s=n.getParameter(D.MAX_TEXTURE_MAX_ANISOTROPY_EXT)}else s=0;return s}function o(D){return!(D!==yn&&i.convert(D)!==n.getParameter(n.IMPLEMENTATION_COLOR_READ_FORMAT))}function a(D){const N=D===Cr&&(t.has("EXT_color_buffer_half_float")||t.has("EXT_color_buffer_float"));return!(D!==ui&&i.convert(D)!==n.getParameter(n.IMPLEMENTATION_COLOR_READ_TYPE)&&D!==On&&!N)}function l(D){if(D==="highp"){if(n.getShaderPrecisionFormat(n.VERTEX_SHADER,n.HIGH_FLOAT).precision>0&&n.getShaderPrecisionFormat(n.FRAGMENT_SHADER,n.HIGH_FLOAT).precision>0)return"highp";D="mediump"}return D==="mediump"&&n.getShaderPrecisionFormat(n.VERTEX_SHADER,n.MEDIUM_FLOAT).precision>0&&n.getShaderPrecisionFormat(n.FRAGMENT_SHADER,n.MEDIUM_FLOAT).precision>0?"mediump":"lowp"}let u=e.precision!==void 0?e.precision:"highp";const c=l(u);c!==u&&(console.warn("THREE.WebGLRenderer:",u,"not supported, using",c,"instead."),u=c);const h=e.logarithmicDepthBuffer===!0,d=e.reverseDepthBuffer===!0&&t.has("EXT_clip_control"),p=n.getParameter(n.MAX_TEXTURE_IMAGE_UNITS),g=n.getParameter(n.MAX_VERTEX_TEXTURE_IMAGE_UNITS),v=n.getParameter(n.MAX_TEXTURE_SIZE),m=n.getParameter(n.MAX_CUBE_MAP_TEXTURE_SIZE),f=n.getParameter(n.MAX_VERTEX_ATTRIBS),w=n.getParameter(n.MAX_VERTEX_UNIFORM_VECTORS),b=n.getParameter(n.MAX_VARYING_VECTORS),x=n.getParameter(n.MAX_FRAGMENT_UNIFORM_VECTORS),B=g>0,P=n.getParameter(n.MAX_SAMPLES);return{isWebGL2:!0,getMaxAnisotropy:r,getMaxPrecision:l,textureFormatReadable:o,textureTypeReadable:a,precision:u,logarithmicDepthBuffer:h,reverseDepthBuffer:d,maxTextures:p,maxVertexTextures:g,maxTextureSize:v,maxCubemapSize:m,maxAttributes:f,maxVertexUniforms:w,maxVaryings:b,maxFragmentUniforms:x,vertexTextures:B,maxSamples:P}}function kx(n){const t=this;let e=null,i=0,s=!1,r=!1;const o=new Mi,a=new Wt,l={value:null,needsUpdate:!1};this.uniform=l,this.numPlanes=0,this.numIntersection=0,this.init=function(h,d){const p=h.length!==0||d||i!==0||s;return s=d,i=h.length,p},this.beginShadows=function(){r=!0,c(null)},this.endShadows=function(){r=!1},this.setGlobalState=function(h,d){e=c(h,d,0)},this.setState=function(h,d,p){const g=h.clippingPlanes,v=h.clipIntersection,m=h.clipShadows,f=n.get(h);if(!s||g===null||g.length===0||r&&!m)r?c(null):u();else{const w=r?0:i,b=w*4;let x=f.clippingState||null;l.value=x,x=c(g,d,b,p);for(let B=0;B!==b;++B)x[B]=e[B];f.clippingState=x,this.numIntersection=v?this.numPlanes:0,this.numPlanes+=w}};function u(){l.value!==e&&(l.value=e,l.needsUpdate=i>0),t.numPlanes=i,t.numIntersection=0}function c(h,d,p,g){const v=h!==null?h.length:0;let m=null;if(v!==0){if(m=l.value,g!==!0||m===null){const f=p+v*4,w=d.matrixWorldInverse;a.getNormalMatrix(w),(m===null||m.length<f)&&(m=new Float32Array(f));for(let b=0,x=p;b!==v;++b,x+=4)o.copy(h[b]).applyMatrix4(w,a),o.normal.toArray(m,x),m[x+3]=o.constant}l.value=m,l.needsUpdate=!0}return t.numPlanes=v,t.numIntersection=0,m}}function Hx(n){let t=new WeakMap;function e(o,a){return a===Tl?o.mapping=Os:a===Al&&(o.mapping=Fs),o}function i(o){if(o&&o.isTexture){const a=o.mapping;if(a===Tl||a===Al)if(t.has(o)){const l=t.get(o).texture;return e(l,o.mapping)}else{const l=o.image;if(l&&l.height>0){const u=new Jg(l.height);return u.fromEquirectangularTexture(n,o),t.set(o,u),o.addEventListener("dispose",s),e(u.texture,o.mapping)}else return null}}return o}function s(o){const a=o.target;a.removeEventListener("dispose",s);const l=t.get(a);l!==void 0&&(t.delete(a),l.dispose())}function r(){t=new WeakMap}return{get:i,dispose:r}}class kd extends Fd{constructor(t=-1,e=1,i=1,s=-1,r=.1,o=2e3){super(),this.isOrthographicCamera=!0,this.type="OrthographicCamera",this.zoom=1,this.view=null,this.left=t,this.right=e,this.top=i,this.bottom=s,this.near=r,this.far=o,this.updateProjectionMatrix()}copy(t,e){return super.copy(t,e),this.left=t.left,this.right=t.right,this.top=t.top,this.bottom=t.bottom,this.near=t.near,this.far=t.far,this.zoom=t.zoom,this.view=t.view===null?null:Object.assign({},t.view),this}setViewOffset(t,e,i,s,r,o){this.view===null&&(this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1}),this.view.enabled=!0,this.view.fullWidth=t,this.view.fullHeight=e,this.view.offsetX=i,this.view.offsetY=s,this.view.width=r,this.view.height=o,this.updateProjectionMatrix()}clearViewOffset(){this.view!==null&&(this.view.enabled=!1),this.updateProjectionMatrix()}updateProjectionMatrix(){const t=(this.right-this.left)/(2*this.zoom),e=(this.top-this.bottom)/(2*this.zoom),i=(this.right+this.left)/2,s=(this.top+this.bottom)/2;let r=i-t,o=i+t,a=s+e,l=s-e;if(this.view!==null&&this.view.enabled){const u=(this.right-this.left)/this.view.fullWidth/this.zoom,c=(this.top-this.bottom)/this.view.fullHeight/this.zoom;r+=u*this.view.offsetX,o=r+u*this.view.width,a-=c*this.view.offsetY,l=a-c*this.view.height}this.projectionMatrix.makeOrthographic(r,o,a,l,this.near,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(t){const e=super.toJSON(t);return e.object.zoom=this.zoom,e.object.left=this.left,e.object.right=this.right,e.object.top=this.top,e.object.bottom=this.bottom,e.object.near=this.near,e.object.far=this.far,this.view!==null&&(e.object.view=Object.assign({},this.view)),e}}const ws=4,hh=[.125,.215,.35,.446,.526,.582],ji=20,Xa=new kd,fh=new $t;let qa=null,Ya=0,ja=0,Ka=!1;const Xi=(1+Math.sqrt(5))/2,Ss=1/Xi,dh=[new G(-Xi,Ss,0),new G(Xi,Ss,0),new G(-Ss,0,Xi),new G(Ss,0,Xi),new G(0,Xi,-Ss),new G(0,Xi,Ss),new G(-1,1,-1),new G(1,1,-1),new G(-1,1,1),new G(1,1,1)];class ph{constructor(t){this._renderer=t,this._pingPongRenderTarget=null,this._lodMax=0,this._cubeSize=0,this._lodPlanes=[],this._sizeLods=[],this._sigmas=[],this._blurMaterial=null,this._cubemapMaterial=null,this._equirectMaterial=null,this._compileMaterial(this._blurMaterial)}fromScene(t,e=0,i=.1,s=100){qa=this._renderer.getRenderTarget(),Ya=this._renderer.getActiveCubeFace(),ja=this._renderer.getActiveMipmapLevel(),Ka=this._renderer.xr.enabled,this._renderer.xr.enabled=!1,this._setSize(256);const r=this._allocateTargets();return r.depthBuffer=!0,this._sceneToCubeUV(t,i,s,r),e>0&&this._blur(r,0,0,e),this._applyPMREM(r),this._cleanup(r),r}fromEquirectangular(t,e=null){return this._fromTexture(t,e)}fromCubemap(t,e=null){return this._fromTexture(t,e)}compileCubemapShader(){this._cubemapMaterial===null&&(this._cubemapMaterial=gh(),this._compileMaterial(this._cubemapMaterial))}compileEquirectangularShader(){this._equirectMaterial===null&&(this._equirectMaterial=_h(),this._compileMaterial(this._equirectMaterial))}dispose(){this._dispose(),this._cubemapMaterial!==null&&this._cubemapMaterial.dispose(),this._equirectMaterial!==null&&this._equirectMaterial.dispose()}_setSize(t){this._lodMax=Math.floor(Math.log2(t)),this._cubeSize=Math.pow(2,this._lodMax)}_dispose(){this._blurMaterial!==null&&this._blurMaterial.dispose(),this._pingPongRenderTarget!==null&&this._pingPongRenderTarget.dispose();for(let t=0;t<this._lodPlanes.length;t++)this._lodPlanes[t].dispose()}_cleanup(t){this._renderer.setRenderTarget(qa,Ya,ja),this._renderer.xr.enabled=Ka,t.scissorTest=!1,oo(t,0,0,t.width,t.height)}_fromTexture(t,e){t.mapping===Os||t.mapping===Fs?this._setSize(t.image.length===0?16:t.image[0].width||t.image[0].image.width):this._setSize(t.image.width/4),qa=this._renderer.getRenderTarget(),Ya=this._renderer.getActiveCubeFace(),ja=this._renderer.getActiveMipmapLevel(),Ka=this._renderer.xr.enabled,this._renderer.xr.enabled=!1;const i=e||this._allocateTargets();return this._textureToCubeUV(t,i),this._applyPMREM(i),this._cleanup(i),i}_allocateTargets(){const t=3*Math.max(this._cubeSize,112),e=4*this._cubeSize,i={magFilter:Nn,minFilter:Nn,generateMipmaps:!1,type:Cr,format:yn,colorSpace:Hs,depthBuffer:!1},s=mh(t,e,i);if(this._pingPongRenderTarget===null||this._pingPongRenderTarget.width!==t||this._pingPongRenderTarget.height!==e){this._pingPongRenderTarget!==null&&this._dispose(),this._pingPongRenderTarget=mh(t,e,i);const{_lodMax:r}=this;({sizeLods:this._sizeLods,lodPlanes:this._lodPlanes,sigmas:this._sigmas}=Vx(r)),this._blurMaterial=Gx(r,t,e)}return s}_compileMaterial(t){const e=new qe(this._lodPlanes[0],t);this._renderer.compile(e,Xa)}_sceneToCubeUV(t,e,i,s){const a=new on(90,1,e,i),l=[1,-1,1,1,1,1],u=[1,1,1,-1,-1,-1],c=this._renderer,h=c.autoClear,d=c.toneMapping;c.getClearColor(fh),c.toneMapping=Ri,c.autoClear=!1;const p=new Yi({name:"PMREM.Background",side:Ye,depthWrite:!1,depthTest:!1}),g=new qe(new is,p);let v=!1;const m=t.background;m?m.isColor&&(p.color.copy(m),t.background=null,v=!0):(p.color.copy(fh),v=!0);for(let f=0;f<6;f++){const w=f%3;w===0?(a.up.set(0,l[f],0),a.lookAt(u[f],0,0)):w===1?(a.up.set(0,0,l[f]),a.lookAt(0,u[f],0)):(a.up.set(0,l[f],0),a.lookAt(0,0,u[f]));const b=this._cubeSize;oo(s,w*b,f>2?b:0,b,b),c.setRenderTarget(s),v&&c.render(g,a),c.render(t,a)}g.geometry.dispose(),g.material.dispose(),c.toneMapping=d,c.autoClear=h,t.background=m}_textureToCubeUV(t,e){const i=this._renderer,s=t.mapping===Os||t.mapping===Fs;s?(this._cubemapMaterial===null&&(this._cubemapMaterial=gh()),this._cubemapMaterial.uniforms.flipEnvMap.value=t.isRenderTargetTexture===!1?-1:1):this._equirectMaterial===null&&(this._equirectMaterial=_h());const r=s?this._cubemapMaterial:this._equirectMaterial,o=new qe(this._lodPlanes[0],r),a=r.uniforms;a.envMap.value=t;const l=this._cubeSize;oo(e,0,0,3*l,2*l),i.setRenderTarget(e),i.render(o,Xa)}_applyPMREM(t){const e=this._renderer,i=e.autoClear;e.autoClear=!1;const s=this._lodPlanes.length;for(let r=1;r<s;r++){const o=Math.sqrt(this._sigmas[r]*this._sigmas[r]-this._sigmas[r-1]*this._sigmas[r-1]),a=dh[(s-r-1)%dh.length];this._blur(t,r-1,r,o,a)}e.autoClear=i}_blur(t,e,i,s,r){const o=this._pingPongRenderTarget;this._halfBlur(t,o,e,i,s,"latitudinal",r),this._halfBlur(o,t,i,i,s,"longitudinal",r)}_halfBlur(t,e,i,s,r,o,a){const l=this._renderer,u=this._blurMaterial;o!=="latitudinal"&&o!=="longitudinal"&&console.error("blur direction must be either latitudinal or longitudinal!");const c=3,h=new qe(this._lodPlanes[s],u),d=u.uniforms,p=this._sizeLods[i]-1,g=isFinite(r)?Math.PI/(2*p):2*Math.PI/(2*ji-1),v=r/g,m=isFinite(r)?1+Math.floor(c*v):ji;m>ji&&console.warn(`sigmaRadians, ${r}, is too large and will clip, as it requested ${m} samples when the maximum is set to ${ji}`);const f=[];let w=0;for(let D=0;D<ji;++D){const N=D/v,E=Math.exp(-N*N/2);f.push(E),D===0?w+=E:D<m&&(w+=2*E)}for(let D=0;D<f.length;D++)f[D]=f[D]/w;d.envMap.value=t.texture,d.samples.value=m,d.weights.value=f,d.latitudinal.value=o==="latitudinal",a&&(d.poleAxis.value=a);const{_lodMax:b}=this;d.dTheta.value=g,d.mipInt.value=b-i;const x=this._sizeLods[s],B=3*x*(s>b-ws?s-b+ws:0),P=4*(this._cubeSize-x);oo(e,B,P,3*x,2*x),l.setRenderTarget(e),l.render(h,Xa)}}function Vx(n){const t=[],e=[],i=[];let s=n;const r=n-ws+1+hh.length;for(let o=0;o<r;o++){const a=Math.pow(2,s);e.push(a);let l=1/a;o>n-ws?l=hh[o-n+ws-1]:o===0&&(l=0),i.push(l);const u=1/(a-2),c=-u,h=1+u,d=[c,c,h,c,h,h,c,c,h,h,c,h],p=6,g=6,v=3,m=2,f=1,w=new Float32Array(v*g*p),b=new Float32Array(m*g*p),x=new Float32Array(f*g*p);for(let P=0;P<p;P++){const D=P%3*2/3-1,N=P>2?0:-1,E=[D,N,0,D+2/3,N,0,D+2/3,N+1,0,D,N,0,D+2/3,N+1,0,D,N+1,0];w.set(E,v*g*P),b.set(d,m*g*P);const M=[P,P,P,P,P,P];x.set(M,f*g*P)}const B=new qn;B.setAttribute("position",new En(w,v)),B.setAttribute("uv",new En(b,m)),B.setAttribute("faceIndex",new En(x,f)),t.push(B),s>ws&&s--}return{lodPlanes:t,sizeLods:e,sigmas:i}}function mh(n,t,e){const i=new ns(n,t,e);return i.texture.mapping=na,i.texture.name="PMREM.cubeUv",i.scissorTest=!0,i}function oo(n,t,e,i,s){n.viewport.set(t,e,i,s),n.scissor.set(t,e,i,s)}function Gx(n,t,e){const i=new Float32Array(ji),s=new G(0,1,0);return new Li({name:"SphericalGaussianBlur",defines:{n:ji,CUBEUV_TEXEL_WIDTH:1/t,CUBEUV_TEXEL_HEIGHT:1/e,CUBEUV_MAX_MIP:`${n}.0`},uniforms:{envMap:{value:null},samples:{value:1},weights:{value:i},latitudinal:{value:!1},dTheta:{value:0},mipInt:{value:0},poleAxis:{value:s}},vertexShader:Bc(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform int samples;
			uniform float weights[ n ];
			uniform bool latitudinal;
			uniform float dTheta;
			uniform float mipInt;
			uniform vec3 poleAxis;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			vec3 getSample( float theta, vec3 axis ) {

				float cosTheta = cos( theta );
				// Rodrigues' axis-angle rotation
				vec3 sampleDirection = vOutputDirection * cosTheta
					+ cross( axis, vOutputDirection ) * sin( theta )
					+ axis * dot( axis, vOutputDirection ) * ( 1.0 - cosTheta );

				return bilinearCubeUV( envMap, sampleDirection, mipInt );

			}

			void main() {

				vec3 axis = latitudinal ? poleAxis : cross( poleAxis, vOutputDirection );

				if ( all( equal( axis, vec3( 0.0 ) ) ) ) {

					axis = vec3( vOutputDirection.z, 0.0, - vOutputDirection.x );

				}

				axis = normalize( axis );

				gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
				gl_FragColor.rgb += weights[ 0 ] * getSample( 0.0, axis );

				for ( int i = 1; i < n; i++ ) {

					if ( i >= samples ) {

						break;

					}

					float theta = dTheta * float( i );
					gl_FragColor.rgb += weights[ i ] * getSample( -1.0 * theta, axis );
					gl_FragColor.rgb += weights[ i ] * getSample( theta, axis );

				}

			}
		`,blending:wi,depthTest:!1,depthWrite:!1})}function _h(){return new Li({name:"EquirectangularToCubeUV",uniforms:{envMap:{value:null}},vertexShader:Bc(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		`,blending:wi,depthTest:!1,depthWrite:!1})}function gh(){return new Li({name:"CubemapToCubeUV",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:Bc(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		`,blending:wi,depthTest:!1,depthWrite:!1})}function Bc(){return`

		precision mediump float;
		precision mediump int;

		attribute float faceIndex;

		varying vec3 vOutputDirection;

		// RH coordinate system; PMREM face-indexing convention
		vec3 getDirection( vec2 uv, float face ) {

			uv = 2.0 * uv - 1.0;

			vec3 direction = vec3( uv, 1.0 );

			if ( face == 0.0 ) {

				direction = direction.zyx; // ( 1, v, u ) pos x

			} else if ( face == 1.0 ) {

				direction = direction.xzy;
				direction.xz *= -1.0; // ( -u, 1, -v ) pos y

			} else if ( face == 2.0 ) {

				direction.x *= -1.0; // ( -u, v, 1 ) pos z

			} else if ( face == 3.0 ) {

				direction = direction.zyx;
				direction.xz *= -1.0; // ( -1, v, -u ) neg x

			} else if ( face == 4.0 ) {

				direction = direction.xzy;
				direction.xy *= -1.0; // ( -u, -1, v ) neg y

			} else if ( face == 5.0 ) {

				direction.z *= -1.0; // ( u, v, -1 ) neg z

			}

			return direction;

		}

		void main() {

			vOutputDirection = getDirection( uv, faceIndex );
			gl_Position = vec4( position, 1.0 );

		}
	`}function Wx(n){let t=new WeakMap,e=null;function i(a){if(a&&a.isTexture){const l=a.mapping,u=l===Tl||l===Al,c=l===Os||l===Fs;if(u||c){let h=t.get(a);const d=h!==void 0?h.texture.pmremVersion:0;if(a.isRenderTargetTexture&&a.pmremVersion!==d)return e===null&&(e=new ph(n)),h=u?e.fromEquirectangular(a,h):e.fromCubemap(a,h),h.texture.pmremVersion=a.pmremVersion,t.set(a,h),h.texture;if(h!==void 0)return h.texture;{const p=a.image;return u&&p&&p.height>0||c&&p&&s(p)?(e===null&&(e=new ph(n)),h=u?e.fromEquirectangular(a):e.fromCubemap(a),h.texture.pmremVersion=a.pmremVersion,t.set(a,h),a.addEventListener("dispose",r),h.texture):null}}}return a}function s(a){let l=0;const u=6;for(let c=0;c<u;c++)a[c]!==void 0&&l++;return l===u}function r(a){const l=a.target;l.removeEventListener("dispose",r);const u=t.get(l);u!==void 0&&(t.delete(l),u.dispose())}function o(){t=new WeakMap,e!==null&&(e.dispose(),e=null)}return{get:i,dispose:o}}function Xx(n){const t={};function e(i){if(t[i]!==void 0)return t[i];let s;switch(i){case"WEBGL_depth_texture":s=n.getExtension("WEBGL_depth_texture")||n.getExtension("MOZ_WEBGL_depth_texture")||n.getExtension("WEBKIT_WEBGL_depth_texture");break;case"EXT_texture_filter_anisotropic":s=n.getExtension("EXT_texture_filter_anisotropic")||n.getExtension("MOZ_EXT_texture_filter_anisotropic")||n.getExtension("WEBKIT_EXT_texture_filter_anisotropic");break;case"WEBGL_compressed_texture_s3tc":s=n.getExtension("WEBGL_compressed_texture_s3tc")||n.getExtension("MOZ_WEBGL_compressed_texture_s3tc")||n.getExtension("WEBKIT_WEBGL_compressed_texture_s3tc");break;case"WEBGL_compressed_texture_pvrtc":s=n.getExtension("WEBGL_compressed_texture_pvrtc")||n.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc");break;default:s=n.getExtension(i)}return t[i]=s,s}return{has:function(i){return e(i)!==null},init:function(){e("EXT_color_buffer_float"),e("WEBGL_clip_cull_distance"),e("OES_texture_float_linear"),e("EXT_color_buffer_half_float"),e("WEBGL_multisampled_render_to_texture"),e("WEBGL_render_shared_exponent")},get:function(i){const s=e(i);return s===null&&sr("THREE.WebGLRenderer: "+i+" extension not supported."),s}}}function qx(n,t,e,i){const s={},r=new WeakMap;function o(h){const d=h.target;d.index!==null&&t.remove(d.index);for(const g in d.attributes)t.remove(d.attributes[g]);for(const g in d.morphAttributes){const v=d.morphAttributes[g];for(let m=0,f=v.length;m<f;m++)t.remove(v[m])}d.removeEventListener("dispose",o),delete s[d.id];const p=r.get(d);p&&(t.remove(p),r.delete(d)),i.releaseStatesOfGeometry(d),d.isInstancedBufferGeometry===!0&&delete d._maxInstanceCount,e.memory.geometries--}function a(h,d){return s[d.id]===!0||(d.addEventListener("dispose",o),s[d.id]=!0,e.memory.geometries++),d}function l(h){const d=h.attributes;for(const g in d)t.update(d[g],n.ARRAY_BUFFER);const p=h.morphAttributes;for(const g in p){const v=p[g];for(let m=0,f=v.length;m<f;m++)t.update(v[m],n.ARRAY_BUFFER)}}function u(h){const d=[],p=h.index,g=h.attributes.position;let v=0;if(p!==null){const w=p.array;v=p.version;for(let b=0,x=w.length;b<x;b+=3){const B=w[b+0],P=w[b+1],D=w[b+2];d.push(B,P,P,D,D,B)}}else if(g!==void 0){const w=g.array;v=g.version;for(let b=0,x=w.length/3-1;b<x;b+=3){const B=b+0,P=b+1,D=b+2;d.push(B,P,P,D,D,B)}}else return;const m=new(Rd(d)?Nd:Ud)(d,1);m.version=v;const f=r.get(h);f&&t.remove(f),r.set(h,m)}function c(h){const d=r.get(h);if(d){const p=h.index;p!==null&&d.version<p.version&&u(h)}else u(h);return r.get(h)}return{get:a,update:l,getWireframeAttribute:c}}function Yx(n,t,e){let i;function s(d){i=d}let r,o;function a(d){r=d.type,o=d.bytesPerElement}function l(d,p){n.drawElements(i,p,r,d*o),e.update(p,i,1)}function u(d,p,g){g!==0&&(n.drawElementsInstanced(i,p,r,d*o,g),e.update(p,i,g))}function c(d,p,g){if(g===0)return;t.get("WEBGL_multi_draw").multiDrawElementsWEBGL(i,p,0,r,d,0,g);let m=0;for(let f=0;f<g;f++)m+=p[f];e.update(m,i,1)}function h(d,p,g,v){if(g===0)return;const m=t.get("WEBGL_multi_draw");if(m===null)for(let f=0;f<d.length;f++)u(d[f]/o,p[f],v[f]);else{m.multiDrawElementsInstancedWEBGL(i,p,0,r,d,0,v,0,g);let f=0;for(let w=0;w<g;w++)f+=p[w]*v[w];e.update(f,i,1)}}this.setMode=s,this.setIndex=a,this.render=l,this.renderInstances=u,this.renderMultiDraw=c,this.renderMultiDrawInstances=h}function jx(n){const t={geometries:0,textures:0},e={frame:0,calls:0,triangles:0,points:0,lines:0};function i(r,o,a){switch(e.calls++,o){case n.TRIANGLES:e.triangles+=a*(r/3);break;case n.LINES:e.lines+=a*(r/2);break;case n.LINE_STRIP:e.lines+=a*(r-1);break;case n.LINE_LOOP:e.lines+=a*r;break;case n.POINTS:e.points+=a*r;break;default:console.error("THREE.WebGLInfo: Unknown draw mode:",o);break}}function s(){e.calls=0,e.triangles=0,e.points=0,e.lines=0}return{memory:t,render:e,programs:null,autoReset:!0,reset:s,update:i}}function Kx(n,t,e){const i=new WeakMap,s=new ge;function r(o,a,l){const u=o.morphTargetInfluences,c=a.morphAttributes.position||a.morphAttributes.normal||a.morphAttributes.color,h=c!==void 0?c.length:0;let d=i.get(a);if(d===void 0||d.count!==h){let M=function(){N.dispose(),i.delete(a),a.removeEventListener("dispose",M)};var p=M;d!==void 0&&d.texture.dispose();const g=a.morphAttributes.position!==void 0,v=a.morphAttributes.normal!==void 0,m=a.morphAttributes.color!==void 0,f=a.morphAttributes.position||[],w=a.morphAttributes.normal||[],b=a.morphAttributes.color||[];let x=0;g===!0&&(x=1),v===!0&&(x=2),m===!0&&(x=3);let B=a.attributes.position.count*x,P=1;B>t.maxTextureSize&&(P=Math.ceil(B/t.maxTextureSize),B=t.maxTextureSize);const D=new Float32Array(B*P*4*h),N=new Pd(D,B,P,h);N.type=On,N.needsUpdate=!0;const E=x*4;for(let L=0;L<h;L++){const J=f[L],C=w[L],k=b[L],Y=B*P*4*L;for(let H=0;H<J.count;H++){const q=H*E;g===!0&&(s.fromBufferAttribute(J,H),D[Y+q+0]=s.x,D[Y+q+1]=s.y,D[Y+q+2]=s.z,D[Y+q+3]=0),v===!0&&(s.fromBufferAttribute(C,H),D[Y+q+4]=s.x,D[Y+q+5]=s.y,D[Y+q+6]=s.z,D[Y+q+7]=0),m===!0&&(s.fromBufferAttribute(k,H),D[Y+q+8]=s.x,D[Y+q+9]=s.y,D[Y+q+10]=s.z,D[Y+q+11]=k.itemSize===4?s.w:1)}}d={count:h,texture:N,size:new kt(B,P)},i.set(a,d),a.addEventListener("dispose",M)}if(o.isInstancedMesh===!0&&o.morphTexture!==null)l.getUniforms().setValue(n,"morphTexture",o.morphTexture,e);else{let g=0;for(let m=0;m<u.length;m++)g+=u[m];const v=a.morphTargetsRelative?1:1-g;l.getUniforms().setValue(n,"morphTargetBaseInfluence",v),l.getUniforms().setValue(n,"morphTargetInfluences",u)}l.getUniforms().setValue(n,"morphTargetsTexture",d.texture,e),l.getUniforms().setValue(n,"morphTargetsTextureSize",d.size)}return{update:r}}function $x(n,t,e,i){let s=new WeakMap;function r(l){const u=i.render.frame,c=l.geometry,h=t.get(l,c);if(s.get(h)!==u&&(t.update(h),s.set(h,u)),l.isInstancedMesh&&(l.hasEventListener("dispose",a)===!1&&l.addEventListener("dispose",a),s.get(l)!==u&&(e.update(l.instanceMatrix,n.ARRAY_BUFFER),l.instanceColor!==null&&e.update(l.instanceColor,n.ARRAY_BUFFER),s.set(l,u))),l.isSkinnedMesh){const d=l.skeleton;s.get(d)!==u&&(d.update(),s.set(d,u))}return h}function o(){s=new WeakMap}function a(l){const u=l.target;u.removeEventListener("dispose",a),e.remove(u.instanceMatrix),u.instanceColor!==null&&e.remove(u.instanceColor)}return{update:r,dispose:o}}class Hd extends ze{constructor(t,e,i,s,r,o,a,l,u,c=Ds){if(c!==Ds&&c!==zs)throw new Error("DepthTexture format must be either THREE.DepthFormat or THREE.DepthStencilFormat");i===void 0&&c===Ds&&(i=es),i===void 0&&c===zs&&(i=Bs),super(null,s,r,o,a,l,c,i,u),this.isDepthTexture=!0,this.image={width:t,height:e},this.magFilter=a!==void 0?a:Je,this.minFilter=l!==void 0?l:Je,this.flipY=!1,this.generateMipmaps=!1,this.compareFunction=null}copy(t){return super.copy(t),this.compareFunction=t.compareFunction,this}toJSON(t){const e=super.toJSON(t);return this.compareFunction!==null&&(e.compareFunction=this.compareFunction),e}}const Vd=new ze,vh=new Hd(1,1),Gd=new Pd,Wd=new Og,Xd=new Bd,xh=[],yh=[],Mh=new Float32Array(16),Sh=new Float32Array(9),Eh=new Float32Array(4);function Vs(n,t,e){const i=n[0];if(i<=0||i>0)return n;const s=t*e;let r=xh[s];if(r===void 0&&(r=new Float32Array(s),xh[s]=r),t!==0){i.toArray(r,0);for(let o=1,a=0;o!==t;++o)a+=e,n[o].toArray(r,a)}return r}function Se(n,t){if(n.length!==t.length)return!1;for(let e=0,i=n.length;e<i;e++)if(n[e]!==t[e])return!1;return!0}function Ee(n,t){for(let e=0,i=t.length;e<i;e++)n[e]=t[e]}function ra(n,t){let e=yh[t];e===void 0&&(e=new Int32Array(t),yh[t]=e);for(let i=0;i!==t;++i)e[i]=n.allocateTextureUnit();return e}function Zx(n,t){const e=this.cache;e[0]!==t&&(n.uniform1f(this.addr,t),e[0]=t)}function Jx(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(n.uniform2f(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(Se(e,t))return;n.uniform2fv(this.addr,t),Ee(e,t)}}function Qx(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(n.uniform3f(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else if(t.r!==void 0)(e[0]!==t.r||e[1]!==t.g||e[2]!==t.b)&&(n.uniform3f(this.addr,t.r,t.g,t.b),e[0]=t.r,e[1]=t.g,e[2]=t.b);else{if(Se(e,t))return;n.uniform3fv(this.addr,t),Ee(e,t)}}function ty(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(n.uniform4f(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(Se(e,t))return;n.uniform4fv(this.addr,t),Ee(e,t)}}function ey(n,t){const e=this.cache,i=t.elements;if(i===void 0){if(Se(e,t))return;n.uniformMatrix2fv(this.addr,!1,t),Ee(e,t)}else{if(Se(e,i))return;Eh.set(i),n.uniformMatrix2fv(this.addr,!1,Eh),Ee(e,i)}}function ny(n,t){const e=this.cache,i=t.elements;if(i===void 0){if(Se(e,t))return;n.uniformMatrix3fv(this.addr,!1,t),Ee(e,t)}else{if(Se(e,i))return;Sh.set(i),n.uniformMatrix3fv(this.addr,!1,Sh),Ee(e,i)}}function iy(n,t){const e=this.cache,i=t.elements;if(i===void 0){if(Se(e,t))return;n.uniformMatrix4fv(this.addr,!1,t),Ee(e,t)}else{if(Se(e,i))return;Mh.set(i),n.uniformMatrix4fv(this.addr,!1,Mh),Ee(e,i)}}function sy(n,t){const e=this.cache;e[0]!==t&&(n.uniform1i(this.addr,t),e[0]=t)}function ry(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(n.uniform2i(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(Se(e,t))return;n.uniform2iv(this.addr,t),Ee(e,t)}}function oy(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(n.uniform3i(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else{if(Se(e,t))return;n.uniform3iv(this.addr,t),Ee(e,t)}}function ay(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(n.uniform4i(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(Se(e,t))return;n.uniform4iv(this.addr,t),Ee(e,t)}}function ly(n,t){const e=this.cache;e[0]!==t&&(n.uniform1ui(this.addr,t),e[0]=t)}function cy(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y)&&(n.uniform2ui(this.addr,t.x,t.y),e[0]=t.x,e[1]=t.y);else{if(Se(e,t))return;n.uniform2uiv(this.addr,t),Ee(e,t)}}function uy(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z)&&(n.uniform3ui(this.addr,t.x,t.y,t.z),e[0]=t.x,e[1]=t.y,e[2]=t.z);else{if(Se(e,t))return;n.uniform3uiv(this.addr,t),Ee(e,t)}}function hy(n,t){const e=this.cache;if(t.x!==void 0)(e[0]!==t.x||e[1]!==t.y||e[2]!==t.z||e[3]!==t.w)&&(n.uniform4ui(this.addr,t.x,t.y,t.z,t.w),e[0]=t.x,e[1]=t.y,e[2]=t.z,e[3]=t.w);else{if(Se(e,t))return;n.uniform4uiv(this.addr,t),Ee(e,t)}}function fy(n,t,e){const i=this.cache,s=e.allocateTextureUnit();i[0]!==s&&(n.uniform1i(this.addr,s),i[0]=s);let r;this.type===n.SAMPLER_2D_SHADOW?(vh.compareFunction=wd,r=vh):r=Vd,e.setTexture2D(t||r,s)}function dy(n,t,e){const i=this.cache,s=e.allocateTextureUnit();i[0]!==s&&(n.uniform1i(this.addr,s),i[0]=s),e.setTexture3D(t||Wd,s)}function py(n,t,e){const i=this.cache,s=e.allocateTextureUnit();i[0]!==s&&(n.uniform1i(this.addr,s),i[0]=s),e.setTextureCube(t||Xd,s)}function my(n,t,e){const i=this.cache,s=e.allocateTextureUnit();i[0]!==s&&(n.uniform1i(this.addr,s),i[0]=s),e.setTexture2DArray(t||Gd,s)}function _y(n){switch(n){case 5126:return Zx;case 35664:return Jx;case 35665:return Qx;case 35666:return ty;case 35674:return ey;case 35675:return ny;case 35676:return iy;case 5124:case 35670:return sy;case 35667:case 35671:return ry;case 35668:case 35672:return oy;case 35669:case 35673:return ay;case 5125:return ly;case 36294:return cy;case 36295:return uy;case 36296:return hy;case 35678:case 36198:case 36298:case 36306:case 35682:return fy;case 35679:case 36299:case 36307:return dy;case 35680:case 36300:case 36308:case 36293:return py;case 36289:case 36303:case 36311:case 36292:return my}}function gy(n,t){n.uniform1fv(this.addr,t)}function vy(n,t){const e=Vs(t,this.size,2);n.uniform2fv(this.addr,e)}function xy(n,t){const e=Vs(t,this.size,3);n.uniform3fv(this.addr,e)}function yy(n,t){const e=Vs(t,this.size,4);n.uniform4fv(this.addr,e)}function My(n,t){const e=Vs(t,this.size,4);n.uniformMatrix2fv(this.addr,!1,e)}function Sy(n,t){const e=Vs(t,this.size,9);n.uniformMatrix3fv(this.addr,!1,e)}function Ey(n,t){const e=Vs(t,this.size,16);n.uniformMatrix4fv(this.addr,!1,e)}function by(n,t){n.uniform1iv(this.addr,t)}function Ty(n,t){n.uniform2iv(this.addr,t)}function Ay(n,t){n.uniform3iv(this.addr,t)}function wy(n,t){n.uniform4iv(this.addr,t)}function Ry(n,t){n.uniform1uiv(this.addr,t)}function Cy(n,t){n.uniform2uiv(this.addr,t)}function Py(n,t){n.uniform3uiv(this.addr,t)}function Dy(n,t){n.uniform4uiv(this.addr,t)}function Ly(n,t,e){const i=this.cache,s=t.length,r=ra(e,s);Se(i,r)||(n.uniform1iv(this.addr,r),Ee(i,r));for(let o=0;o!==s;++o)e.setTexture2D(t[o]||Vd,r[o])}function Iy(n,t,e){const i=this.cache,s=t.length,r=ra(e,s);Se(i,r)||(n.uniform1iv(this.addr,r),Ee(i,r));for(let o=0;o!==s;++o)e.setTexture3D(t[o]||Wd,r[o])}function Uy(n,t,e){const i=this.cache,s=t.length,r=ra(e,s);Se(i,r)||(n.uniform1iv(this.addr,r),Ee(i,r));for(let o=0;o!==s;++o)e.setTextureCube(t[o]||Xd,r[o])}function Ny(n,t,e){const i=this.cache,s=t.length,r=ra(e,s);Se(i,r)||(n.uniform1iv(this.addr,r),Ee(i,r));for(let o=0;o!==s;++o)e.setTexture2DArray(t[o]||Gd,r[o])}function Oy(n){switch(n){case 5126:return gy;case 35664:return vy;case 35665:return xy;case 35666:return yy;case 35674:return My;case 35675:return Sy;case 35676:return Ey;case 5124:case 35670:return by;case 35667:case 35671:return Ty;case 35668:case 35672:return Ay;case 35669:case 35673:return wy;case 5125:return Ry;case 36294:return Cy;case 36295:return Py;case 36296:return Dy;case 35678:case 36198:case 36298:case 36306:case 35682:return Ly;case 35679:case 36299:case 36307:return Iy;case 35680:case 36300:case 36308:case 36293:return Uy;case 36289:case 36303:case 36311:case 36292:return Ny}}class Fy{constructor(t,e,i){this.id=t,this.addr=i,this.cache=[],this.type=e.type,this.setValue=_y(e.type)}}class By{constructor(t,e,i){this.id=t,this.addr=i,this.cache=[],this.type=e.type,this.size=e.size,this.setValue=Oy(e.type)}}class zy{constructor(t){this.id=t,this.seq=[],this.map={}}setValue(t,e,i){const s=this.seq;for(let r=0,o=s.length;r!==o;++r){const a=s[r];a.setValue(t,e[a.id],i)}}}const $a=/(\w+)(\])?(\[|\.)?/g;function bh(n,t){n.seq.push(t),n.map[t.id]=t}function ky(n,t,e){const i=n.name,s=i.length;for($a.lastIndex=0;;){const r=$a.exec(i),o=$a.lastIndex;let a=r[1];const l=r[2]==="]",u=r[3];if(l&&(a=a|0),u===void 0||u==="["&&o+2===s){bh(e,u===void 0?new Fy(a,n,t):new By(a,n,t));break}else{let h=e.map[a];h===void 0&&(h=new zy(a),bh(e,h)),e=h}}}class Eo{constructor(t,e){this.seq=[],this.map={};const i=t.getProgramParameter(e,t.ACTIVE_UNIFORMS);for(let s=0;s<i;++s){const r=t.getActiveUniform(e,s),o=t.getUniformLocation(e,r.name);ky(r,o,this)}}setValue(t,e,i,s){const r=this.map[e];r!==void 0&&r.setValue(t,i,s)}setOptional(t,e,i){const s=e[i];s!==void 0&&this.setValue(t,i,s)}static upload(t,e,i,s){for(let r=0,o=e.length;r!==o;++r){const a=e[r],l=i[a.id];l.needsUpdate!==!1&&a.setValue(t,l.value,s)}}static seqWithValue(t,e){const i=[];for(let s=0,r=t.length;s!==r;++s){const o=t[s];o.id in e&&i.push(o)}return i}}function Th(n,t,e){const i=n.createShader(t);return n.shaderSource(i,e),n.compileShader(i),i}const Hy=37297;let Vy=0;function Gy(n,t){const e=n.split(`
`),i=[],s=Math.max(t-6,0),r=Math.min(t+6,e.length);for(let o=s;o<r;o++){const a=o+1;i.push(`${a===t?">":" "} ${a}: ${e[o]}`)}return i.join(`
`)}const Ah=new Wt;function Wy(n){Jt._getMatrix(Ah,Jt.workingColorSpace,n);const t=`mat3( ${Ah.elements.map(e=>e.toFixed(4))} )`;switch(Jt.getTransfer(n)){case ia:return[t,"LinearTransferOETF"];case ae:return[t,"sRGBTransferOETF"];default:return console.warn("THREE.WebGLProgram: Unsupported color space: ",n),[t,"LinearTransferOETF"]}}function wh(n,t,e){const i=n.getShaderParameter(t,n.COMPILE_STATUS),s=n.getShaderInfoLog(t).trim();if(i&&s==="")return"";const r=/ERROR: 0:(\d+)/.exec(s);if(r){const o=parseInt(r[1]);return e.toUpperCase()+`

`+s+`

`+Gy(n.getShaderSource(t),o)}else return s}function Xy(n,t){const e=Wy(t);return[`vec4 ${n}( vec4 value ) {`,`	return ${e[1]}( vec4( value.rgb * ${e[0]}, value.a ) );`,"}"].join(`
`)}function qy(n,t){let e;switch(t){case ag:e="Linear";break;case lg:e="Reinhard";break;case cg:e="Cineon";break;case ug:e="ACESFilmic";break;case fg:e="AgX";break;case dg:e="Neutral";break;case hg:e="Custom";break;default:console.warn("THREE.WebGLProgram: Unsupported toneMapping:",t),e="Linear"}return"vec3 "+n+"( vec3 color ) { return "+e+"ToneMapping( color ); }"}const ao=new G;function Yy(){Jt.getLuminanceCoefficients(ao);const n=ao.x.toFixed(4),t=ao.y.toFixed(4),e=ao.z.toFixed(4);return["float luminance( const in vec3 rgb ) {",`	const vec3 weights = vec3( ${n}, ${t}, ${e} );`,"	return dot( weights, rgb );","}"].join(`
`)}function jy(n){return[n.extensionClipCullDistance?"#extension GL_ANGLE_clip_cull_distance : require":"",n.extensionMultiDraw?"#extension GL_ANGLE_multi_draw : require":""].filter(rr).join(`
`)}function Ky(n){const t=[];for(const e in n){const i=n[e];i!==!1&&t.push("#define "+e+" "+i)}return t.join(`
`)}function $y(n,t){const e={},i=n.getProgramParameter(t,n.ACTIVE_ATTRIBUTES);for(let s=0;s<i;s++){const r=n.getActiveAttrib(t,s),o=r.name;let a=1;r.type===n.FLOAT_MAT2&&(a=2),r.type===n.FLOAT_MAT3&&(a=3),r.type===n.FLOAT_MAT4&&(a=4),e[o]={type:r.type,location:n.getAttribLocation(t,o),locationSize:a}}return e}function rr(n){return n!==""}function Rh(n,t){const e=t.numSpotLightShadows+t.numSpotLightMaps-t.numSpotLightShadowsWithMaps;return n.replace(/NUM_DIR_LIGHTS/g,t.numDirLights).replace(/NUM_SPOT_LIGHTS/g,t.numSpotLights).replace(/NUM_SPOT_LIGHT_MAPS/g,t.numSpotLightMaps).replace(/NUM_SPOT_LIGHT_COORDS/g,e).replace(/NUM_RECT_AREA_LIGHTS/g,t.numRectAreaLights).replace(/NUM_POINT_LIGHTS/g,t.numPointLights).replace(/NUM_HEMI_LIGHTS/g,t.numHemiLights).replace(/NUM_DIR_LIGHT_SHADOWS/g,t.numDirLightShadows).replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g,t.numSpotLightShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g,t.numSpotLightShadows).replace(/NUM_POINT_LIGHT_SHADOWS/g,t.numPointLightShadows)}function Ch(n,t){return n.replace(/NUM_CLIPPING_PLANES/g,t.numClippingPlanes).replace(/UNION_CLIPPING_PLANES/g,t.numClippingPlanes-t.numClipIntersection)}const Zy=/^[ \t]*#include +<([\w\d./]+)>/gm;function nc(n){return n.replace(Zy,Qy)}const Jy=new Map;function Qy(n,t){let e=Xt[t];if(e===void 0){const i=Jy.get(t);if(i!==void 0)e=Xt[i],console.warn('THREE.WebGLRenderer: Shader chunk "%s" has been deprecated. Use "%s" instead.',t,i);else throw new Error("Can not resolve #include <"+t+">")}return nc(e)}const tM=/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;function Ph(n){return n.replace(tM,eM)}function eM(n,t,e,i){let s="";for(let r=parseInt(t);r<parseInt(e);r++)s+=i.replace(/\[\s*i\s*\]/g,"[ "+r+" ]").replace(/UNROLLED_LOOP_INDEX/g,r);return s}function Dh(n){let t=`precision ${n.precision} float;
	precision ${n.precision} int;
	precision ${n.precision} sampler2D;
	precision ${n.precision} samplerCube;
	precision ${n.precision} sampler3D;
	precision ${n.precision} sampler2DArray;
	precision ${n.precision} sampler2DShadow;
	precision ${n.precision} samplerCubeShadow;
	precision ${n.precision} sampler2DArrayShadow;
	precision ${n.precision} isampler2D;
	precision ${n.precision} isampler3D;
	precision ${n.precision} isamplerCube;
	precision ${n.precision} isampler2DArray;
	precision ${n.precision} usampler2D;
	precision ${n.precision} usampler3D;
	precision ${n.precision} usamplerCube;
	precision ${n.precision} usampler2DArray;
	`;return n.precision==="highp"?t+=`
#define HIGH_PRECISION`:n.precision==="mediump"?t+=`
#define MEDIUM_PRECISION`:n.precision==="lowp"&&(t+=`
#define LOW_PRECISION`),t}function nM(n){let t="SHADOWMAP_TYPE_BASIC";return n.shadowMapType===md?t="SHADOWMAP_TYPE_PCF":n.shadowMapType===k_?t="SHADOWMAP_TYPE_PCF_SOFT":n.shadowMapType===ei&&(t="SHADOWMAP_TYPE_VSM"),t}function iM(n){let t="ENVMAP_TYPE_CUBE";if(n.envMap)switch(n.envMapMode){case Os:case Fs:t="ENVMAP_TYPE_CUBE";break;case na:t="ENVMAP_TYPE_CUBE_UV";break}return t}function sM(n){let t="ENVMAP_MODE_REFLECTION";if(n.envMap)switch(n.envMapMode){case Fs:t="ENVMAP_MODE_REFRACTION";break}return t}function rM(n){let t="ENVMAP_BLENDING_NONE";if(n.envMap)switch(n.combine){case Cc:t="ENVMAP_BLENDING_MULTIPLY";break;case rg:t="ENVMAP_BLENDING_MIX";break;case og:t="ENVMAP_BLENDING_ADD";break}return t}function oM(n){const t=n.envMapCubeUVHeight;if(t===null)return null;const e=Math.log2(t)-2,i=1/t;return{texelWidth:1/(3*Math.max(Math.pow(2,e),112)),texelHeight:i,maxMip:e}}function aM(n,t,e,i){const s=n.getContext(),r=e.defines;let o=e.vertexShader,a=e.fragmentShader;const l=nM(e),u=iM(e),c=sM(e),h=rM(e),d=oM(e),p=jy(e),g=Ky(r),v=s.createProgram();let m,f,w=e.glslVersion?"#version "+e.glslVersion+`
`:"";e.isRawShaderMaterial?(m=["#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,g].filter(rr).join(`
`),m.length>0&&(m+=`
`),f=["#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,g].filter(rr).join(`
`),f.length>0&&(f+=`
`)):(m=[Dh(e),"#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,g,e.extensionClipCullDistance?"#define USE_CLIP_DISTANCE":"",e.batching?"#define USE_BATCHING":"",e.batchingColor?"#define USE_BATCHING_COLOR":"",e.instancing?"#define USE_INSTANCING":"",e.instancingColor?"#define USE_INSTANCING_COLOR":"",e.instancingMorph?"#define USE_INSTANCING_MORPH":"",e.useFog&&e.fog?"#define USE_FOG":"",e.useFog&&e.fogExp2?"#define FOG_EXP2":"",e.map?"#define USE_MAP":"",e.envMap?"#define USE_ENVMAP":"",e.envMap?"#define "+c:"",e.lightMap?"#define USE_LIGHTMAP":"",e.aoMap?"#define USE_AOMAP":"",e.bumpMap?"#define USE_BUMPMAP":"",e.normalMap?"#define USE_NORMALMAP":"",e.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",e.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",e.displacementMap?"#define USE_DISPLACEMENTMAP":"",e.emissiveMap?"#define USE_EMISSIVEMAP":"",e.anisotropy?"#define USE_ANISOTROPY":"",e.anisotropyMap?"#define USE_ANISOTROPYMAP":"",e.clearcoatMap?"#define USE_CLEARCOATMAP":"",e.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",e.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",e.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",e.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",e.specularMap?"#define USE_SPECULARMAP":"",e.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",e.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",e.roughnessMap?"#define USE_ROUGHNESSMAP":"",e.metalnessMap?"#define USE_METALNESSMAP":"",e.alphaMap?"#define USE_ALPHAMAP":"",e.alphaHash?"#define USE_ALPHAHASH":"",e.transmission?"#define USE_TRANSMISSION":"",e.transmissionMap?"#define USE_TRANSMISSIONMAP":"",e.thicknessMap?"#define USE_THICKNESSMAP":"",e.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",e.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",e.mapUv?"#define MAP_UV "+e.mapUv:"",e.alphaMapUv?"#define ALPHAMAP_UV "+e.alphaMapUv:"",e.lightMapUv?"#define LIGHTMAP_UV "+e.lightMapUv:"",e.aoMapUv?"#define AOMAP_UV "+e.aoMapUv:"",e.emissiveMapUv?"#define EMISSIVEMAP_UV "+e.emissiveMapUv:"",e.bumpMapUv?"#define BUMPMAP_UV "+e.bumpMapUv:"",e.normalMapUv?"#define NORMALMAP_UV "+e.normalMapUv:"",e.displacementMapUv?"#define DISPLACEMENTMAP_UV "+e.displacementMapUv:"",e.metalnessMapUv?"#define METALNESSMAP_UV "+e.metalnessMapUv:"",e.roughnessMapUv?"#define ROUGHNESSMAP_UV "+e.roughnessMapUv:"",e.anisotropyMapUv?"#define ANISOTROPYMAP_UV "+e.anisotropyMapUv:"",e.clearcoatMapUv?"#define CLEARCOATMAP_UV "+e.clearcoatMapUv:"",e.clearcoatNormalMapUv?"#define CLEARCOAT_NORMALMAP_UV "+e.clearcoatNormalMapUv:"",e.clearcoatRoughnessMapUv?"#define CLEARCOAT_ROUGHNESSMAP_UV "+e.clearcoatRoughnessMapUv:"",e.iridescenceMapUv?"#define IRIDESCENCEMAP_UV "+e.iridescenceMapUv:"",e.iridescenceThicknessMapUv?"#define IRIDESCENCE_THICKNESSMAP_UV "+e.iridescenceThicknessMapUv:"",e.sheenColorMapUv?"#define SHEEN_COLORMAP_UV "+e.sheenColorMapUv:"",e.sheenRoughnessMapUv?"#define SHEEN_ROUGHNESSMAP_UV "+e.sheenRoughnessMapUv:"",e.specularMapUv?"#define SPECULARMAP_UV "+e.specularMapUv:"",e.specularColorMapUv?"#define SPECULAR_COLORMAP_UV "+e.specularColorMapUv:"",e.specularIntensityMapUv?"#define SPECULAR_INTENSITYMAP_UV "+e.specularIntensityMapUv:"",e.transmissionMapUv?"#define TRANSMISSIONMAP_UV "+e.transmissionMapUv:"",e.thicknessMapUv?"#define THICKNESSMAP_UV "+e.thicknessMapUv:"",e.vertexTangents&&e.flatShading===!1?"#define USE_TANGENT":"",e.vertexColors?"#define USE_COLOR":"",e.vertexAlphas?"#define USE_COLOR_ALPHA":"",e.vertexUv1s?"#define USE_UV1":"",e.vertexUv2s?"#define USE_UV2":"",e.vertexUv3s?"#define USE_UV3":"",e.pointsUvs?"#define USE_POINTS_UV":"",e.flatShading?"#define FLAT_SHADED":"",e.skinning?"#define USE_SKINNING":"",e.morphTargets?"#define USE_MORPHTARGETS":"",e.morphNormals&&e.flatShading===!1?"#define USE_MORPHNORMALS":"",e.morphColors?"#define USE_MORPHCOLORS":"",e.morphTargetsCount>0?"#define MORPHTARGETS_TEXTURE_STRIDE "+e.morphTextureStride:"",e.morphTargetsCount>0?"#define MORPHTARGETS_COUNT "+e.morphTargetsCount:"",e.doubleSided?"#define DOUBLE_SIDED":"",e.flipSided?"#define FLIP_SIDED":"",e.shadowMapEnabled?"#define USE_SHADOWMAP":"",e.shadowMapEnabled?"#define "+l:"",e.sizeAttenuation?"#define USE_SIZEATTENUATION":"",e.numLightProbes>0?"#define USE_LIGHT_PROBES":"",e.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",e.reverseDepthBuffer?"#define USE_REVERSEDEPTHBUF":"","uniform mat4 modelMatrix;","uniform mat4 modelViewMatrix;","uniform mat4 projectionMatrix;","uniform mat4 viewMatrix;","uniform mat3 normalMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;","#ifdef USE_INSTANCING","	attribute mat4 instanceMatrix;","#endif","#ifdef USE_INSTANCING_COLOR","	attribute vec3 instanceColor;","#endif","#ifdef USE_INSTANCING_MORPH","	uniform sampler2D morphTexture;","#endif","attribute vec3 position;","attribute vec3 normal;","attribute vec2 uv;","#ifdef USE_UV1","	attribute vec2 uv1;","#endif","#ifdef USE_UV2","	attribute vec2 uv2;","#endif","#ifdef USE_UV3","	attribute vec2 uv3;","#endif","#ifdef USE_TANGENT","	attribute vec4 tangent;","#endif","#if defined( USE_COLOR_ALPHA )","	attribute vec4 color;","#elif defined( USE_COLOR )","	attribute vec3 color;","#endif","#ifdef USE_SKINNING","	attribute vec4 skinIndex;","	attribute vec4 skinWeight;","#endif",`
`].filter(rr).join(`
`),f=[Dh(e),"#define SHADER_TYPE "+e.shaderType,"#define SHADER_NAME "+e.shaderName,g,e.useFog&&e.fog?"#define USE_FOG":"",e.useFog&&e.fogExp2?"#define FOG_EXP2":"",e.alphaToCoverage?"#define ALPHA_TO_COVERAGE":"",e.map?"#define USE_MAP":"",e.matcap?"#define USE_MATCAP":"",e.envMap?"#define USE_ENVMAP":"",e.envMap?"#define "+u:"",e.envMap?"#define "+c:"",e.envMap?"#define "+h:"",d?"#define CUBEUV_TEXEL_WIDTH "+d.texelWidth:"",d?"#define CUBEUV_TEXEL_HEIGHT "+d.texelHeight:"",d?"#define CUBEUV_MAX_MIP "+d.maxMip+".0":"",e.lightMap?"#define USE_LIGHTMAP":"",e.aoMap?"#define USE_AOMAP":"",e.bumpMap?"#define USE_BUMPMAP":"",e.normalMap?"#define USE_NORMALMAP":"",e.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",e.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",e.emissiveMap?"#define USE_EMISSIVEMAP":"",e.anisotropy?"#define USE_ANISOTROPY":"",e.anisotropyMap?"#define USE_ANISOTROPYMAP":"",e.clearcoat?"#define USE_CLEARCOAT":"",e.clearcoatMap?"#define USE_CLEARCOATMAP":"",e.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",e.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",e.dispersion?"#define USE_DISPERSION":"",e.iridescence?"#define USE_IRIDESCENCE":"",e.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",e.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",e.specularMap?"#define USE_SPECULARMAP":"",e.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",e.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",e.roughnessMap?"#define USE_ROUGHNESSMAP":"",e.metalnessMap?"#define USE_METALNESSMAP":"",e.alphaMap?"#define USE_ALPHAMAP":"",e.alphaTest?"#define USE_ALPHATEST":"",e.alphaHash?"#define USE_ALPHAHASH":"",e.sheen?"#define USE_SHEEN":"",e.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",e.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",e.transmission?"#define USE_TRANSMISSION":"",e.transmissionMap?"#define USE_TRANSMISSIONMAP":"",e.thicknessMap?"#define USE_THICKNESSMAP":"",e.vertexTangents&&e.flatShading===!1?"#define USE_TANGENT":"",e.vertexColors||e.instancingColor||e.batchingColor?"#define USE_COLOR":"",e.vertexAlphas?"#define USE_COLOR_ALPHA":"",e.vertexUv1s?"#define USE_UV1":"",e.vertexUv2s?"#define USE_UV2":"",e.vertexUv3s?"#define USE_UV3":"",e.pointsUvs?"#define USE_POINTS_UV":"",e.gradientMap?"#define USE_GRADIENTMAP":"",e.flatShading?"#define FLAT_SHADED":"",e.doubleSided?"#define DOUBLE_SIDED":"",e.flipSided?"#define FLIP_SIDED":"",e.shadowMapEnabled?"#define USE_SHADOWMAP":"",e.shadowMapEnabled?"#define "+l:"",e.premultipliedAlpha?"#define PREMULTIPLIED_ALPHA":"",e.numLightProbes>0?"#define USE_LIGHT_PROBES":"",e.decodeVideoTexture?"#define DECODE_VIDEO_TEXTURE":"",e.decodeVideoTextureEmissive?"#define DECODE_VIDEO_TEXTURE_EMISSIVE":"",e.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",e.reverseDepthBuffer?"#define USE_REVERSEDEPTHBUF":"","uniform mat4 viewMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;",e.toneMapping!==Ri?"#define TONE_MAPPING":"",e.toneMapping!==Ri?Xt.tonemapping_pars_fragment:"",e.toneMapping!==Ri?qy("toneMapping",e.toneMapping):"",e.dithering?"#define DITHERING":"",e.opaque?"#define OPAQUE":"",Xt.colorspace_pars_fragment,Xy("linearToOutputTexel",e.outputColorSpace),Yy(),e.useDepthPacking?"#define DEPTH_PACKING "+e.depthPacking:"",`
`].filter(rr).join(`
`)),o=nc(o),o=Rh(o,e),o=Ch(o,e),a=nc(a),a=Rh(a,e),a=Ch(a,e),o=Ph(o),a=Ph(a),e.isRawShaderMaterial!==!0&&(w=`#version 300 es
`,m=[p,"#define attribute in","#define varying out","#define texture2D texture"].join(`
`)+`
`+m,f=["#define varying in",e.glslVersion===Wu?"":"layout(location = 0) out highp vec4 pc_fragColor;",e.glslVersion===Wu?"":"#define gl_FragColor pc_fragColor","#define gl_FragDepthEXT gl_FragDepth","#define texture2D texture","#define textureCube texture","#define texture2DProj textureProj","#define texture2DLodEXT textureLod","#define texture2DProjLodEXT textureProjLod","#define textureCubeLodEXT textureLod","#define texture2DGradEXT textureGrad","#define texture2DProjGradEXT textureProjGrad","#define textureCubeGradEXT textureGrad"].join(`
`)+`
`+f);const b=w+m+o,x=w+f+a,B=Th(s,s.VERTEX_SHADER,b),P=Th(s,s.FRAGMENT_SHADER,x);s.attachShader(v,B),s.attachShader(v,P),e.index0AttributeName!==void 0?s.bindAttribLocation(v,0,e.index0AttributeName):e.morphTargets===!0&&s.bindAttribLocation(v,0,"position"),s.linkProgram(v);function D(L){if(n.debug.checkShaderErrors){const J=s.getProgramInfoLog(v).trim(),C=s.getShaderInfoLog(B).trim(),k=s.getShaderInfoLog(P).trim();let Y=!0,H=!0;if(s.getProgramParameter(v,s.LINK_STATUS)===!1)if(Y=!1,typeof n.debug.onShaderError=="function")n.debug.onShaderError(s,v,B,P);else{const q=wh(s,B,"vertex"),z=wh(s,P,"fragment");console.error("THREE.WebGLProgram: Shader Error "+s.getError()+" - VALIDATE_STATUS "+s.getProgramParameter(v,s.VALIDATE_STATUS)+`

Material Name: `+L.name+`
Material Type: `+L.type+`

Program Info Log: `+J+`
`+q+`
`+z)}else J!==""?console.warn("THREE.WebGLProgram: Program Info Log:",J):(C===""||k==="")&&(H=!1);H&&(L.diagnostics={runnable:Y,programLog:J,vertexShader:{log:C,prefix:m},fragmentShader:{log:k,prefix:f}})}s.deleteShader(B),s.deleteShader(P),N=new Eo(s,v),E=$y(s,v)}let N;this.getUniforms=function(){return N===void 0&&D(this),N};let E;this.getAttributes=function(){return E===void 0&&D(this),E};let M=e.rendererExtensionParallelShaderCompile===!1;return this.isReady=function(){return M===!1&&(M=s.getProgramParameter(v,Hy)),M},this.destroy=function(){i.releaseStatesOfProgram(this),s.deleteProgram(v),this.program=void 0},this.type=e.shaderType,this.name=e.shaderName,this.id=Vy++,this.cacheKey=t,this.usedTimes=1,this.program=v,this.vertexShader=B,this.fragmentShader=P,this}let lM=0;class cM{constructor(){this.shaderCache=new Map,this.materialCache=new Map}update(t){const e=t.vertexShader,i=t.fragmentShader,s=this._getShaderStage(e),r=this._getShaderStage(i),o=this._getShaderCacheForMaterial(t);return o.has(s)===!1&&(o.add(s),s.usedTimes++),o.has(r)===!1&&(o.add(r),r.usedTimes++),this}remove(t){const e=this.materialCache.get(t);for(const i of e)i.usedTimes--,i.usedTimes===0&&this.shaderCache.delete(i.code);return this.materialCache.delete(t),this}getVertexShaderID(t){return this._getShaderStage(t.vertexShader).id}getFragmentShaderID(t){return this._getShaderStage(t.fragmentShader).id}dispose(){this.shaderCache.clear(),this.materialCache.clear()}_getShaderCacheForMaterial(t){const e=this.materialCache;let i=e.get(t);return i===void 0&&(i=new Set,e.set(t,i)),i}_getShaderStage(t){const e=this.shaderCache;let i=e.get(t);return i===void 0&&(i=new uM(t),e.set(t,i)),i}}class uM{constructor(t){this.id=lM++,this.code=t,this.usedTimes=0}}function hM(n,t,e,i,s,r,o){const a=new Ld,l=new cM,u=new Set,c=[],h=s.logarithmicDepthBuffer,d=s.vertexTextures;let p=s.precision;const g={MeshDepthMaterial:"depth",MeshDistanceMaterial:"distanceRGBA",MeshNormalMaterial:"normal",MeshBasicMaterial:"basic",MeshLambertMaterial:"lambert",MeshPhongMaterial:"phong",MeshToonMaterial:"toon",MeshStandardMaterial:"physical",MeshPhysicalMaterial:"physical",MeshMatcapMaterial:"matcap",LineBasicMaterial:"basic",LineDashedMaterial:"dashed",PointsMaterial:"points",ShadowMaterial:"shadow",SpriteMaterial:"sprite"};function v(E){return u.add(E),E===0?"uv":`uv${E}`}function m(E,M,L,J,C){const k=J.fog,Y=C.geometry,H=E.isMeshStandardMaterial?J.environment:null,q=(E.isMeshStandardMaterial?e:t).get(E.envMap||H),z=q&&q.mapping===na?q.image.height:null,at=g[E.type];E.precision!==null&&(p=s.getMaxPrecision(E.precision),p!==E.precision&&console.warn("THREE.WebGLProgram.getParameters:",E.precision,"not supported, using",p,"instead."));const dt=Y.morphAttributes.position||Y.morphAttributes.normal||Y.morphAttributes.color,bt=dt!==void 0?dt.length:0;let Ut=0;Y.morphAttributes.position!==void 0&&(Ut=1),Y.morphAttributes.normal!==void 0&&(Ut=2),Y.morphAttributes.color!==void 0&&(Ut=3);let ee,it,ut,Tt;if(at){const re=Dn[at];ee=re.vertexShader,it=re.fragmentShader}else ee=E.vertexShader,it=E.fragmentShader,l.update(E),ut=l.getVertexShaderID(E),Tt=l.getFragmentShaderID(E);const mt=n.getRenderTarget(),It=n.state.buffers.depth.getReversed(),Nt=C.isInstancedMesh===!0,Yt=C.isBatchedMesh===!0,A=!!E.map,R=!!E.matcap,X=!!q,T=!!E.aoMap,nt=!!E.lightMap,Z=!!E.bumpMap,st=!!E.normalMap,tt=!!E.displacementMap,rt=!!E.emissiveMap,V=!!E.metalnessMap,S=!!E.roughnessMap,_=E.anisotropy>0,I=E.clearcoat>0,W=E.dispersion>0,Q=E.iridescence>0,$=E.sheen>0,ht=E.transmission>0,ct=_&&!!E.anisotropyMap,pt=I&&!!E.clearcoatMap,Ft=I&&!!E.clearcoatNormalMap,lt=I&&!!E.clearcoatRoughnessMap,St=Q&&!!E.iridescenceMap,Lt=Q&&!!E.iridescenceThicknessMap,At=$&&!!E.sheenColorMap,gt=$&&!!E.sheenRoughnessMap,Kt=!!E.specularMap,zt=!!E.specularColorMap,he=!!E.specularIntensityMap,U=ht&&!!E.transmissionMap,vt=ht&&!!E.thicknessMap,et=!!E.gradientMap,ot=!!E.alphaMap,Et=E.alphaTest>0,yt=!!E.alphaHash,Vt=!!E.extensions;let _e=Ri;E.toneMapped&&(mt===null||mt.isXRRenderTarget===!0)&&(_e=n.toneMapping);const Re={shaderID:at,shaderType:E.type,shaderName:E.name,vertexShader:ee,fragmentShader:it,defines:E.defines,customVertexShaderID:ut,customFragmentShaderID:Tt,isRawShaderMaterial:E.isRawShaderMaterial===!0,glslVersion:E.glslVersion,precision:p,batching:Yt,batchingColor:Yt&&C._colorsTexture!==null,instancing:Nt,instancingColor:Nt&&C.instanceColor!==null,instancingMorph:Nt&&C.morphTexture!==null,supportsVertexTextures:d,outputColorSpace:mt===null?n.outputColorSpace:mt.isXRRenderTarget===!0?mt.texture.colorSpace:Hs,alphaToCoverage:!!E.alphaToCoverage,map:A,matcap:R,envMap:X,envMapMode:X&&q.mapping,envMapCubeUVHeight:z,aoMap:T,lightMap:nt,bumpMap:Z,normalMap:st,displacementMap:d&&tt,emissiveMap:rt,normalMapObjectSpace:st&&E.normalMapType===gg,normalMapTangentSpace:st&&E.normalMapType===Ad,metalnessMap:V,roughnessMap:S,anisotropy:_,anisotropyMap:ct,clearcoat:I,clearcoatMap:pt,clearcoatNormalMap:Ft,clearcoatRoughnessMap:lt,dispersion:W,iridescence:Q,iridescenceMap:St,iridescenceThicknessMap:Lt,sheen:$,sheenColorMap:At,sheenRoughnessMap:gt,specularMap:Kt,specularColorMap:zt,specularIntensityMap:he,transmission:ht,transmissionMap:U,thicknessMap:vt,gradientMap:et,opaque:E.transparent===!1&&E.blending===Ps&&E.alphaToCoverage===!1,alphaMap:ot,alphaTest:Et,alphaHash:yt,combine:E.combine,mapUv:A&&v(E.map.channel),aoMapUv:T&&v(E.aoMap.channel),lightMapUv:nt&&v(E.lightMap.channel),bumpMapUv:Z&&v(E.bumpMap.channel),normalMapUv:st&&v(E.normalMap.channel),displacementMapUv:tt&&v(E.displacementMap.channel),emissiveMapUv:rt&&v(E.emissiveMap.channel),metalnessMapUv:V&&v(E.metalnessMap.channel),roughnessMapUv:S&&v(E.roughnessMap.channel),anisotropyMapUv:ct&&v(E.anisotropyMap.channel),clearcoatMapUv:pt&&v(E.clearcoatMap.channel),clearcoatNormalMapUv:Ft&&v(E.clearcoatNormalMap.channel),clearcoatRoughnessMapUv:lt&&v(E.clearcoatRoughnessMap.channel),iridescenceMapUv:St&&v(E.iridescenceMap.channel),iridescenceThicknessMapUv:Lt&&v(E.iridescenceThicknessMap.channel),sheenColorMapUv:At&&v(E.sheenColorMap.channel),sheenRoughnessMapUv:gt&&v(E.sheenRoughnessMap.channel),specularMapUv:Kt&&v(E.specularMap.channel),specularColorMapUv:zt&&v(E.specularColorMap.channel),specularIntensityMapUv:he&&v(E.specularIntensityMap.channel),transmissionMapUv:U&&v(E.transmissionMap.channel),thicknessMapUv:vt&&v(E.thicknessMap.channel),alphaMapUv:ot&&v(E.alphaMap.channel),vertexTangents:!!Y.attributes.tangent&&(st||_),vertexColors:E.vertexColors,vertexAlphas:E.vertexColors===!0&&!!Y.attributes.color&&Y.attributes.color.itemSize===4,pointsUvs:C.isPoints===!0&&!!Y.attributes.uv&&(A||ot),fog:!!k,useFog:E.fog===!0,fogExp2:!!k&&k.isFogExp2,flatShading:E.flatShading===!0,sizeAttenuation:E.sizeAttenuation===!0,logarithmicDepthBuffer:h,reverseDepthBuffer:It,skinning:C.isSkinnedMesh===!0,morphTargets:Y.morphAttributes.position!==void 0,morphNormals:Y.morphAttributes.normal!==void 0,morphColors:Y.morphAttributes.color!==void 0,morphTargetsCount:bt,morphTextureStride:Ut,numDirLights:M.directional.length,numPointLights:M.point.length,numSpotLights:M.spot.length,numSpotLightMaps:M.spotLightMap.length,numRectAreaLights:M.rectArea.length,numHemiLights:M.hemi.length,numDirLightShadows:M.directionalShadowMap.length,numPointLightShadows:M.pointShadowMap.length,numSpotLightShadows:M.spotShadowMap.length,numSpotLightShadowsWithMaps:M.numSpotLightShadowsWithMaps,numLightProbes:M.numLightProbes,numClippingPlanes:o.numPlanes,numClipIntersection:o.numIntersection,dithering:E.dithering,shadowMapEnabled:n.shadowMap.enabled&&L.length>0,shadowMapType:n.shadowMap.type,toneMapping:_e,decodeVideoTexture:A&&E.map.isVideoTexture===!0&&Jt.getTransfer(E.map.colorSpace)===ae,decodeVideoTextureEmissive:rt&&E.emissiveMap.isVideoTexture===!0&&Jt.getTransfer(E.emissiveMap.colorSpace)===ae,premultipliedAlpha:E.premultipliedAlpha,doubleSided:E.side===In,flipSided:E.side===Ye,useDepthPacking:E.depthPacking>=0,depthPacking:E.depthPacking||0,index0AttributeName:E.index0AttributeName,extensionClipCullDistance:Vt&&E.extensions.clipCullDistance===!0&&i.has("WEBGL_clip_cull_distance"),extensionMultiDraw:(Vt&&E.extensions.multiDraw===!0||Yt)&&i.has("WEBGL_multi_draw"),rendererExtensionParallelShaderCompile:i.has("KHR_parallel_shader_compile"),customProgramCacheKey:E.customProgramCacheKey()};return Re.vertexUv1s=u.has(1),Re.vertexUv2s=u.has(2),Re.vertexUv3s=u.has(3),u.clear(),Re}function f(E){const M=[];if(E.shaderID?M.push(E.shaderID):(M.push(E.customVertexShaderID),M.push(E.customFragmentShaderID)),E.defines!==void 0)for(const L in E.defines)M.push(L),M.push(E.defines[L]);return E.isRawShaderMaterial===!1&&(w(M,E),b(M,E),M.push(n.outputColorSpace)),M.push(E.customProgramCacheKey),M.join()}function w(E,M){E.push(M.precision),E.push(M.outputColorSpace),E.push(M.envMapMode),E.push(M.envMapCubeUVHeight),E.push(M.mapUv),E.push(M.alphaMapUv),E.push(M.lightMapUv),E.push(M.aoMapUv),E.push(M.bumpMapUv),E.push(M.normalMapUv),E.push(M.displacementMapUv),E.push(M.emissiveMapUv),E.push(M.metalnessMapUv),E.push(M.roughnessMapUv),E.push(M.anisotropyMapUv),E.push(M.clearcoatMapUv),E.push(M.clearcoatNormalMapUv),E.push(M.clearcoatRoughnessMapUv),E.push(M.iridescenceMapUv),E.push(M.iridescenceThicknessMapUv),E.push(M.sheenColorMapUv),E.push(M.sheenRoughnessMapUv),E.push(M.specularMapUv),E.push(M.specularColorMapUv),E.push(M.specularIntensityMapUv),E.push(M.transmissionMapUv),E.push(M.thicknessMapUv),E.push(M.combine),E.push(M.fogExp2),E.push(M.sizeAttenuation),E.push(M.morphTargetsCount),E.push(M.morphAttributeCount),E.push(M.numDirLights),E.push(M.numPointLights),E.push(M.numSpotLights),E.push(M.numSpotLightMaps),E.push(M.numHemiLights),E.push(M.numRectAreaLights),E.push(M.numDirLightShadows),E.push(M.numPointLightShadows),E.push(M.numSpotLightShadows),E.push(M.numSpotLightShadowsWithMaps),E.push(M.numLightProbes),E.push(M.shadowMapType),E.push(M.toneMapping),E.push(M.numClippingPlanes),E.push(M.numClipIntersection),E.push(M.depthPacking)}function b(E,M){a.disableAll(),M.supportsVertexTextures&&a.enable(0),M.instancing&&a.enable(1),M.instancingColor&&a.enable(2),M.instancingMorph&&a.enable(3),M.matcap&&a.enable(4),M.envMap&&a.enable(5),M.normalMapObjectSpace&&a.enable(6),M.normalMapTangentSpace&&a.enable(7),M.clearcoat&&a.enable(8),M.iridescence&&a.enable(9),M.alphaTest&&a.enable(10),M.vertexColors&&a.enable(11),M.vertexAlphas&&a.enable(12),M.vertexUv1s&&a.enable(13),M.vertexUv2s&&a.enable(14),M.vertexUv3s&&a.enable(15),M.vertexTangents&&a.enable(16),M.anisotropy&&a.enable(17),M.alphaHash&&a.enable(18),M.batching&&a.enable(19),M.dispersion&&a.enable(20),M.batchingColor&&a.enable(21),E.push(a.mask),a.disableAll(),M.fog&&a.enable(0),M.useFog&&a.enable(1),M.flatShading&&a.enable(2),M.logarithmicDepthBuffer&&a.enable(3),M.reverseDepthBuffer&&a.enable(4),M.skinning&&a.enable(5),M.morphTargets&&a.enable(6),M.morphNormals&&a.enable(7),M.morphColors&&a.enable(8),M.premultipliedAlpha&&a.enable(9),M.shadowMapEnabled&&a.enable(10),M.doubleSided&&a.enable(11),M.flipSided&&a.enable(12),M.useDepthPacking&&a.enable(13),M.dithering&&a.enable(14),M.transmission&&a.enable(15),M.sheen&&a.enable(16),M.opaque&&a.enable(17),M.pointsUvs&&a.enable(18),M.decodeVideoTexture&&a.enable(19),M.decodeVideoTextureEmissive&&a.enable(20),M.alphaToCoverage&&a.enable(21),E.push(a.mask)}function x(E){const M=g[E.type];let L;if(M){const J=Dn[M];L=jg.clone(J.uniforms)}else L=E.uniforms;return L}function B(E,M){let L;for(let J=0,C=c.length;J<C;J++){const k=c[J];if(k.cacheKey===M){L=k,++L.usedTimes;break}}return L===void 0&&(L=new aM(n,M,E,r),c.push(L)),L}function P(E){if(--E.usedTimes===0){const M=c.indexOf(E);c[M]=c[c.length-1],c.pop(),E.destroy()}}function D(E){l.remove(E)}function N(){l.dispose()}return{getParameters:m,getProgramCacheKey:f,getUniforms:x,acquireProgram:B,releaseProgram:P,releaseShaderCache:D,programs:c,dispose:N}}function fM(){let n=new WeakMap;function t(o){return n.has(o)}function e(o){let a=n.get(o);return a===void 0&&(a={},n.set(o,a)),a}function i(o){n.delete(o)}function s(o,a,l){n.get(o)[a]=l}function r(){n=new WeakMap}return{has:t,get:e,remove:i,update:s,dispose:r}}function dM(n,t){return n.groupOrder!==t.groupOrder?n.groupOrder-t.groupOrder:n.renderOrder!==t.renderOrder?n.renderOrder-t.renderOrder:n.material.id!==t.material.id?n.material.id-t.material.id:n.z!==t.z?n.z-t.z:n.id-t.id}function Lh(n,t){return n.groupOrder!==t.groupOrder?n.groupOrder-t.groupOrder:n.renderOrder!==t.renderOrder?n.renderOrder-t.renderOrder:n.z!==t.z?t.z-n.z:n.id-t.id}function Ih(){const n=[];let t=0;const e=[],i=[],s=[];function r(){t=0,e.length=0,i.length=0,s.length=0}function o(h,d,p,g,v,m){let f=n[t];return f===void 0?(f={id:h.id,object:h,geometry:d,material:p,groupOrder:g,renderOrder:h.renderOrder,z:v,group:m},n[t]=f):(f.id=h.id,f.object=h,f.geometry=d,f.material=p,f.groupOrder=g,f.renderOrder=h.renderOrder,f.z=v,f.group=m),t++,f}function a(h,d,p,g,v,m){const f=o(h,d,p,g,v,m);p.transmission>0?i.push(f):p.transparent===!0?s.push(f):e.push(f)}function l(h,d,p,g,v,m){const f=o(h,d,p,g,v,m);p.transmission>0?i.unshift(f):p.transparent===!0?s.unshift(f):e.unshift(f)}function u(h,d){e.length>1&&e.sort(h||dM),i.length>1&&i.sort(d||Lh),s.length>1&&s.sort(d||Lh)}function c(){for(let h=t,d=n.length;h<d;h++){const p=n[h];if(p.id===null)break;p.id=null,p.object=null,p.geometry=null,p.material=null,p.group=null}}return{opaque:e,transmissive:i,transparent:s,init:r,push:a,unshift:l,finish:c,sort:u}}function pM(){let n=new WeakMap;function t(i,s){const r=n.get(i);let o;return r===void 0?(o=new Ih,n.set(i,[o])):s>=r.length?(o=new Ih,r.push(o)):o=r[s],o}function e(){n=new WeakMap}return{get:t,dispose:e}}function mM(){const n={};return{get:function(t){if(n[t.id]!==void 0)return n[t.id];let e;switch(t.type){case"DirectionalLight":e={direction:new G,color:new $t};break;case"SpotLight":e={position:new G,direction:new G,color:new $t,distance:0,coneCos:0,penumbraCos:0,decay:0};break;case"PointLight":e={position:new G,color:new $t,distance:0,decay:0};break;case"HemisphereLight":e={direction:new G,skyColor:new $t,groundColor:new $t};break;case"RectAreaLight":e={color:new $t,position:new G,halfWidth:new G,halfHeight:new G};break}return n[t.id]=e,e}}}function _M(){const n={};return{get:function(t){if(n[t.id]!==void 0)return n[t.id];let e;switch(t.type){case"DirectionalLight":e={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new kt};break;case"SpotLight":e={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new kt};break;case"PointLight":e={shadowIntensity:1,shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new kt,shadowCameraNear:1,shadowCameraFar:1e3};break}return n[t.id]=e,e}}}let gM=0;function vM(n,t){return(t.castShadow?2:0)-(n.castShadow?2:0)+(t.map?1:0)-(n.map?1:0)}function xM(n){const t=new mM,e=_M(),i={version:0,hash:{directionalLength:-1,pointLength:-1,spotLength:-1,rectAreaLength:-1,hemiLength:-1,numDirectionalShadows:-1,numPointShadows:-1,numSpotShadows:-1,numSpotMaps:-1,numLightProbes:-1},ambient:[0,0,0],probe:[],directional:[],directionalShadow:[],directionalShadowMap:[],directionalShadowMatrix:[],spot:[],spotLightMap:[],spotShadow:[],spotShadowMap:[],spotLightMatrix:[],rectArea:[],rectAreaLTC1:null,rectAreaLTC2:null,point:[],pointShadow:[],pointShadowMap:[],pointShadowMatrix:[],hemi:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};for(let u=0;u<9;u++)i.probe.push(new G);const s=new G,r=new ue,o=new ue;function a(u){let c=0,h=0,d=0;for(let E=0;E<9;E++)i.probe[E].set(0,0,0);let p=0,g=0,v=0,m=0,f=0,w=0,b=0,x=0,B=0,P=0,D=0;u.sort(vM);for(let E=0,M=u.length;E<M;E++){const L=u[E],J=L.color,C=L.intensity,k=L.distance,Y=L.shadow&&L.shadow.map?L.shadow.map.texture:null;if(L.isAmbientLight)c+=J.r*C,h+=J.g*C,d+=J.b*C;else if(L.isLightProbe){for(let H=0;H<9;H++)i.probe[H].addScaledVector(L.sh.coefficients[H],C);D++}else if(L.isDirectionalLight){const H=t.get(L);if(H.color.copy(L.color).multiplyScalar(L.intensity),L.castShadow){const q=L.shadow,z=e.get(L);z.shadowIntensity=q.intensity,z.shadowBias=q.bias,z.shadowNormalBias=q.normalBias,z.shadowRadius=q.radius,z.shadowMapSize=q.mapSize,i.directionalShadow[p]=z,i.directionalShadowMap[p]=Y,i.directionalShadowMatrix[p]=L.shadow.matrix,w++}i.directional[p]=H,p++}else if(L.isSpotLight){const H=t.get(L);H.position.setFromMatrixPosition(L.matrixWorld),H.color.copy(J).multiplyScalar(C),H.distance=k,H.coneCos=Math.cos(L.angle),H.penumbraCos=Math.cos(L.angle*(1-L.penumbra)),H.decay=L.decay,i.spot[v]=H;const q=L.shadow;if(L.map&&(i.spotLightMap[B]=L.map,B++,q.updateMatrices(L),L.castShadow&&P++),i.spotLightMatrix[v]=q.matrix,L.castShadow){const z=e.get(L);z.shadowIntensity=q.intensity,z.shadowBias=q.bias,z.shadowNormalBias=q.normalBias,z.shadowRadius=q.radius,z.shadowMapSize=q.mapSize,i.spotShadow[v]=z,i.spotShadowMap[v]=Y,x++}v++}else if(L.isRectAreaLight){const H=t.get(L);H.color.copy(J).multiplyScalar(C),H.halfWidth.set(L.width*.5,0,0),H.halfHeight.set(0,L.height*.5,0),i.rectArea[m]=H,m++}else if(L.isPointLight){const H=t.get(L);if(H.color.copy(L.color).multiplyScalar(L.intensity),H.distance=L.distance,H.decay=L.decay,L.castShadow){const q=L.shadow,z=e.get(L);z.shadowIntensity=q.intensity,z.shadowBias=q.bias,z.shadowNormalBias=q.normalBias,z.shadowRadius=q.radius,z.shadowMapSize=q.mapSize,z.shadowCameraNear=q.camera.near,z.shadowCameraFar=q.camera.far,i.pointShadow[g]=z,i.pointShadowMap[g]=Y,i.pointShadowMatrix[g]=L.shadow.matrix,b++}i.point[g]=H,g++}else if(L.isHemisphereLight){const H=t.get(L);H.skyColor.copy(L.color).multiplyScalar(C),H.groundColor.copy(L.groundColor).multiplyScalar(C),i.hemi[f]=H,f++}}m>0&&(n.has("OES_texture_float_linear")===!0?(i.rectAreaLTC1=_t.LTC_FLOAT_1,i.rectAreaLTC2=_t.LTC_FLOAT_2):(i.rectAreaLTC1=_t.LTC_HALF_1,i.rectAreaLTC2=_t.LTC_HALF_2)),i.ambient[0]=c,i.ambient[1]=h,i.ambient[2]=d;const N=i.hash;(N.directionalLength!==p||N.pointLength!==g||N.spotLength!==v||N.rectAreaLength!==m||N.hemiLength!==f||N.numDirectionalShadows!==w||N.numPointShadows!==b||N.numSpotShadows!==x||N.numSpotMaps!==B||N.numLightProbes!==D)&&(i.directional.length=p,i.spot.length=v,i.rectArea.length=m,i.point.length=g,i.hemi.length=f,i.directionalShadow.length=w,i.directionalShadowMap.length=w,i.pointShadow.length=b,i.pointShadowMap.length=b,i.spotShadow.length=x,i.spotShadowMap.length=x,i.directionalShadowMatrix.length=w,i.pointShadowMatrix.length=b,i.spotLightMatrix.length=x+B-P,i.spotLightMap.length=B,i.numSpotLightShadowsWithMaps=P,i.numLightProbes=D,N.directionalLength=p,N.pointLength=g,N.spotLength=v,N.rectAreaLength=m,N.hemiLength=f,N.numDirectionalShadows=w,N.numPointShadows=b,N.numSpotShadows=x,N.numSpotMaps=B,N.numLightProbes=D,i.version=gM++)}function l(u,c){let h=0,d=0,p=0,g=0,v=0;const m=c.matrixWorldInverse;for(let f=0,w=u.length;f<w;f++){const b=u[f];if(b.isDirectionalLight){const x=i.directional[h];x.direction.setFromMatrixPosition(b.matrixWorld),s.setFromMatrixPosition(b.target.matrixWorld),x.direction.sub(s),x.direction.transformDirection(m),h++}else if(b.isSpotLight){const x=i.spot[p];x.position.setFromMatrixPosition(b.matrixWorld),x.position.applyMatrix4(m),x.direction.setFromMatrixPosition(b.matrixWorld),s.setFromMatrixPosition(b.target.matrixWorld),x.direction.sub(s),x.direction.transformDirection(m),p++}else if(b.isRectAreaLight){const x=i.rectArea[g];x.position.setFromMatrixPosition(b.matrixWorld),x.position.applyMatrix4(m),o.identity(),r.copy(b.matrixWorld),r.premultiply(m),o.extractRotation(r),x.halfWidth.set(b.width*.5,0,0),x.halfHeight.set(0,b.height*.5,0),x.halfWidth.applyMatrix4(o),x.halfHeight.applyMatrix4(o),g++}else if(b.isPointLight){const x=i.point[d];x.position.setFromMatrixPosition(b.matrixWorld),x.position.applyMatrix4(m),d++}else if(b.isHemisphereLight){const x=i.hemi[v];x.direction.setFromMatrixPosition(b.matrixWorld),x.direction.transformDirection(m),v++}}}return{setup:a,setupView:l,state:i}}function Uh(n){const t=new xM(n),e=[],i=[];function s(c){u.camera=c,e.length=0,i.length=0}function r(c){e.push(c)}function o(c){i.push(c)}function a(){t.setup(e)}function l(c){t.setupView(e,c)}const u={lightsArray:e,shadowsArray:i,camera:null,lights:t,transmissionRenderTarget:{}};return{init:s,state:u,setupLights:a,setupLightsView:l,pushLight:r,pushShadow:o}}function yM(n){let t=new WeakMap;function e(s,r=0){const o=t.get(s);let a;return o===void 0?(a=new Uh(n),t.set(s,[a])):r>=o.length?(a=new Uh(n),o.push(a)):a=o[r],a}function i(){t=new WeakMap}return{get:e,dispose:i}}class MM extends Lr{static get type(){return"MeshDepthMaterial"}constructor(t){super(),this.isMeshDepthMaterial=!0,this.depthPacking=mg,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.setValues(t)}copy(t){return super.copy(t),this.depthPacking=t.depthPacking,this.map=t.map,this.alphaMap=t.alphaMap,this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this}}class SM extends Lr{static get type(){return"MeshDistanceMaterial"}constructor(t){super(),this.isMeshDistanceMaterial=!0,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.setValues(t)}copy(t){return super.copy(t),this.map=t.map,this.alphaMap=t.alphaMap,this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this}}const EM=`void main() {
	gl_Position = vec4( position, 1.0 );
}`,bM=`uniform sampler2D shadow_pass;
uniform vec2 resolution;
uniform float radius;
#include <packing>
void main() {
	const float samples = float( VSM_SAMPLES );
	float mean = 0.0;
	float squared_mean = 0.0;
	float uvStride = samples <= 1.0 ? 0.0 : 2.0 / ( samples - 1.0 );
	float uvStart = samples <= 1.0 ? 0.0 : - 1.0;
	for ( float i = 0.0; i < samples; i ++ ) {
		float uvOffset = uvStart + i * uvStride;
		#ifdef HORIZONTAL_PASS
			vec2 distribution = unpackRGBATo2Half( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( uvOffset, 0.0 ) * radius ) / resolution ) );
			mean += distribution.x;
			squared_mean += distribution.y * distribution.y + distribution.x * distribution.x;
		#else
			float depth = unpackRGBAToDepth( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( 0.0, uvOffset ) * radius ) / resolution ) );
			mean += depth;
			squared_mean += depth * depth;
		#endif
	}
	mean = mean / samples;
	squared_mean = squared_mean / samples;
	float std_dev = sqrt( squared_mean - mean * mean );
	gl_FragColor = pack2HalfToRGBA( vec2( mean, std_dev ) );
}`;function TM(n,t,e){let i=new Fc;const s=new kt,r=new kt,o=new ge,a=new MM({depthPacking:_g}),l=new SM,u={},c=e.maxTextureSize,h={[Pi]:Ye,[Ye]:Pi,[In]:In},d=new Li({defines:{VSM_SAMPLES:8},uniforms:{shadow_pass:{value:null},resolution:{value:new kt},radius:{value:4}},vertexShader:EM,fragmentShader:bM}),p=d.clone();p.defines.HORIZONTAL_PASS=1;const g=new qn;g.setAttribute("position",new En(new Float32Array([-1,-1,.5,3,-1,.5,-1,3,.5]),3));const v=new qe(g,d),m=this;this.enabled=!1,this.autoUpdate=!0,this.needsUpdate=!1,this.type=md;let f=this.type;this.render=function(P,D,N){if(m.enabled===!1||m.autoUpdate===!1&&m.needsUpdate===!1||P.length===0)return;const E=n.getRenderTarget(),M=n.getActiveCubeFace(),L=n.getActiveMipmapLevel(),J=n.state;J.setBlending(wi),J.buffers.color.setClear(1,1,1,1),J.buffers.depth.setTest(!0),J.setScissorTest(!1);const C=f!==ei&&this.type===ei,k=f===ei&&this.type!==ei;for(let Y=0,H=P.length;Y<H;Y++){const q=P[Y],z=q.shadow;if(z===void 0){console.warn("THREE.WebGLShadowMap:",q,"has no shadow.");continue}if(z.autoUpdate===!1&&z.needsUpdate===!1)continue;s.copy(z.mapSize);const at=z.getFrameExtents();if(s.multiply(at),r.copy(z.mapSize),(s.x>c||s.y>c)&&(s.x>c&&(r.x=Math.floor(c/at.x),s.x=r.x*at.x,z.mapSize.x=r.x),s.y>c&&(r.y=Math.floor(c/at.y),s.y=r.y*at.y,z.mapSize.y=r.y)),z.map===null||C===!0||k===!0){const bt=this.type!==ei?{minFilter:Je,magFilter:Je}:{};z.map!==null&&z.map.dispose(),z.map=new ns(s.x,s.y,bt),z.map.texture.name=q.name+".shadowMap",z.camera.updateProjectionMatrix()}n.setRenderTarget(z.map),n.clear();const dt=z.getViewportCount();for(let bt=0;bt<dt;bt++){const Ut=z.getViewport(bt);o.set(r.x*Ut.x,r.y*Ut.y,r.x*Ut.z,r.y*Ut.w),J.viewport(o),z.updateMatrices(q,bt),i=z.getFrustum(),x(D,N,z.camera,q,this.type)}z.isPointLightShadow!==!0&&this.type===ei&&w(z,N),z.needsUpdate=!1}f=this.type,m.needsUpdate=!1,n.setRenderTarget(E,M,L)};function w(P,D){const N=t.update(v);d.defines.VSM_SAMPLES!==P.blurSamples&&(d.defines.VSM_SAMPLES=P.blurSamples,p.defines.VSM_SAMPLES=P.blurSamples,d.needsUpdate=!0,p.needsUpdate=!0),P.mapPass===null&&(P.mapPass=new ns(s.x,s.y)),d.uniforms.shadow_pass.value=P.map.texture,d.uniforms.resolution.value=P.mapSize,d.uniforms.radius.value=P.radius,n.setRenderTarget(P.mapPass),n.clear(),n.renderBufferDirect(D,null,N,d,v,null),p.uniforms.shadow_pass.value=P.mapPass.texture,p.uniforms.resolution.value=P.mapSize,p.uniforms.radius.value=P.radius,n.setRenderTarget(P.map),n.clear(),n.renderBufferDirect(D,null,N,p,v,null)}function b(P,D,N,E){let M=null;const L=N.isPointLight===!0?P.customDistanceMaterial:P.customDepthMaterial;if(L!==void 0)M=L;else if(M=N.isPointLight===!0?l:a,n.localClippingEnabled&&D.clipShadows===!0&&Array.isArray(D.clippingPlanes)&&D.clippingPlanes.length!==0||D.displacementMap&&D.displacementScale!==0||D.alphaMap&&D.alphaTest>0||D.map&&D.alphaTest>0){const J=M.uuid,C=D.uuid;let k=u[J];k===void 0&&(k={},u[J]=k);let Y=k[C];Y===void 0&&(Y=M.clone(),k[C]=Y,D.addEventListener("dispose",B)),M=Y}if(M.visible=D.visible,M.wireframe=D.wireframe,E===ei?M.side=D.shadowSide!==null?D.shadowSide:D.side:M.side=D.shadowSide!==null?D.shadowSide:h[D.side],M.alphaMap=D.alphaMap,M.alphaTest=D.alphaTest,M.map=D.map,M.clipShadows=D.clipShadows,M.clippingPlanes=D.clippingPlanes,M.clipIntersection=D.clipIntersection,M.displacementMap=D.displacementMap,M.displacementScale=D.displacementScale,M.displacementBias=D.displacementBias,M.wireframeLinewidth=D.wireframeLinewidth,M.linewidth=D.linewidth,N.isPointLight===!0&&M.isMeshDistanceMaterial===!0){const J=n.properties.get(M);J.light=N}return M}function x(P,D,N,E,M){if(P.visible===!1)return;if(P.layers.test(D.layers)&&(P.isMesh||P.isLine||P.isPoints)&&(P.castShadow||P.receiveShadow&&M===ei)&&(!P.frustumCulled||i.intersectsObject(P))){P.modelViewMatrix.multiplyMatrices(N.matrixWorldInverse,P.matrixWorld);const C=t.update(P),k=P.material;if(Array.isArray(k)){const Y=C.groups;for(let H=0,q=Y.length;H<q;H++){const z=Y[H],at=k[z.materialIndex];if(at&&at.visible){const dt=b(P,at,E,M);P.onBeforeShadow(n,P,D,N,C,dt,z),n.renderBufferDirect(N,null,C,dt,P,z),P.onAfterShadow(n,P,D,N,C,dt,z)}}}else if(k.visible){const Y=b(P,k,E,M);P.onBeforeShadow(n,P,D,N,C,Y,null),n.renderBufferDirect(N,null,C,Y,P,null),P.onAfterShadow(n,P,D,N,C,Y,null)}}const J=P.children;for(let C=0,k=J.length;C<k;C++)x(J[C],D,N,E,M)}function B(P){P.target.removeEventListener("dispose",B);for(const N in u){const E=u[N],M=P.target.uuid;M in E&&(E[M].dispose(),delete E[M])}}}const AM={[vl]:xl,[yl]:El,[Ml]:bl,[Ns]:Sl,[xl]:vl,[El]:yl,[bl]:Ml,[Sl]:Ns};function wM(n,t){function e(){let U=!1;const vt=new ge;let et=null;const ot=new ge(0,0,0,0);return{setMask:function(Et){et!==Et&&!U&&(n.colorMask(Et,Et,Et,Et),et=Et)},setLocked:function(Et){U=Et},setClear:function(Et,yt,Vt,_e,Re){Re===!0&&(Et*=_e,yt*=_e,Vt*=_e),vt.set(Et,yt,Vt,_e),ot.equals(vt)===!1&&(n.clearColor(Et,yt,Vt,_e),ot.copy(vt))},reset:function(){U=!1,et=null,ot.set(-1,0,0,0)}}}function i(){let U=!1,vt=!1,et=null,ot=null,Et=null;return{setReversed:function(yt){if(vt!==yt){const Vt=t.get("EXT_clip_control");vt?Vt.clipControlEXT(Vt.LOWER_LEFT_EXT,Vt.ZERO_TO_ONE_EXT):Vt.clipControlEXT(Vt.LOWER_LEFT_EXT,Vt.NEGATIVE_ONE_TO_ONE_EXT);const _e=Et;Et=null,this.setClear(_e)}vt=yt},getReversed:function(){return vt},setTest:function(yt){yt?mt(n.DEPTH_TEST):It(n.DEPTH_TEST)},setMask:function(yt){et!==yt&&!U&&(n.depthMask(yt),et=yt)},setFunc:function(yt){if(vt&&(yt=AM[yt]),ot!==yt){switch(yt){case vl:n.depthFunc(n.NEVER);break;case xl:n.depthFunc(n.ALWAYS);break;case yl:n.depthFunc(n.LESS);break;case Ns:n.depthFunc(n.LEQUAL);break;case Ml:n.depthFunc(n.EQUAL);break;case Sl:n.depthFunc(n.GEQUAL);break;case El:n.depthFunc(n.GREATER);break;case bl:n.depthFunc(n.NOTEQUAL);break;default:n.depthFunc(n.LEQUAL)}ot=yt}},setLocked:function(yt){U=yt},setClear:function(yt){Et!==yt&&(vt&&(yt=1-yt),n.clearDepth(yt),Et=yt)},reset:function(){U=!1,et=null,ot=null,Et=null,vt=!1}}}function s(){let U=!1,vt=null,et=null,ot=null,Et=null,yt=null,Vt=null,_e=null,Re=null;return{setTest:function(re){U||(re?mt(n.STENCIL_TEST):It(n.STENCIL_TEST))},setMask:function(re){vt!==re&&!U&&(n.stencilMask(re),vt=re)},setFunc:function(re,hn,Yn){(et!==re||ot!==hn||Et!==Yn)&&(n.stencilFunc(re,hn,Yn),et=re,ot=hn,Et=Yn)},setOp:function(re,hn,Yn){(yt!==re||Vt!==hn||_e!==Yn)&&(n.stencilOp(re,hn,Yn),yt=re,Vt=hn,_e=Yn)},setLocked:function(re){U=re},setClear:function(re){Re!==re&&(n.clearStencil(re),Re=re)},reset:function(){U=!1,vt=null,et=null,ot=null,Et=null,yt=null,Vt=null,_e=null,Re=null}}}const r=new e,o=new i,a=new s,l=new WeakMap,u=new WeakMap;let c={},h={},d=new WeakMap,p=[],g=null,v=!1,m=null,f=null,w=null,b=null,x=null,B=null,P=null,D=new $t(0,0,0),N=0,E=!1,M=null,L=null,J=null,C=null,k=null;const Y=n.getParameter(n.MAX_COMBINED_TEXTURE_IMAGE_UNITS);let H=!1,q=0;const z=n.getParameter(n.VERSION);z.indexOf("WebGL")!==-1?(q=parseFloat(/^WebGL (\d)/.exec(z)[1]),H=q>=1):z.indexOf("OpenGL ES")!==-1&&(q=parseFloat(/^OpenGL ES (\d)/.exec(z)[1]),H=q>=2);let at=null,dt={};const bt=n.getParameter(n.SCISSOR_BOX),Ut=n.getParameter(n.VIEWPORT),ee=new ge().fromArray(bt),it=new ge().fromArray(Ut);function ut(U,vt,et,ot){const Et=new Uint8Array(4),yt=n.createTexture();n.bindTexture(U,yt),n.texParameteri(U,n.TEXTURE_MIN_FILTER,n.NEAREST),n.texParameteri(U,n.TEXTURE_MAG_FILTER,n.NEAREST);for(let Vt=0;Vt<et;Vt++)U===n.TEXTURE_3D||U===n.TEXTURE_2D_ARRAY?n.texImage3D(vt,0,n.RGBA,1,1,ot,0,n.RGBA,n.UNSIGNED_BYTE,Et):n.texImage2D(vt+Vt,0,n.RGBA,1,1,0,n.RGBA,n.UNSIGNED_BYTE,Et);return yt}const Tt={};Tt[n.TEXTURE_2D]=ut(n.TEXTURE_2D,n.TEXTURE_2D,1),Tt[n.TEXTURE_CUBE_MAP]=ut(n.TEXTURE_CUBE_MAP,n.TEXTURE_CUBE_MAP_POSITIVE_X,6),Tt[n.TEXTURE_2D_ARRAY]=ut(n.TEXTURE_2D_ARRAY,n.TEXTURE_2D_ARRAY,1,1),Tt[n.TEXTURE_3D]=ut(n.TEXTURE_3D,n.TEXTURE_3D,1,1),r.setClear(0,0,0,1),o.setClear(1),a.setClear(0),mt(n.DEPTH_TEST),o.setFunc(Ns),Z(!1),st(Bu),mt(n.CULL_FACE),T(wi);function mt(U){c[U]!==!0&&(n.enable(U),c[U]=!0)}function It(U){c[U]!==!1&&(n.disable(U),c[U]=!1)}function Nt(U,vt){return h[U]!==vt?(n.bindFramebuffer(U,vt),h[U]=vt,U===n.DRAW_FRAMEBUFFER&&(h[n.FRAMEBUFFER]=vt),U===n.FRAMEBUFFER&&(h[n.DRAW_FRAMEBUFFER]=vt),!0):!1}function Yt(U,vt){let et=p,ot=!1;if(U){et=d.get(vt),et===void 0&&(et=[],d.set(vt,et));const Et=U.textures;if(et.length!==Et.length||et[0]!==n.COLOR_ATTACHMENT0){for(let yt=0,Vt=Et.length;yt<Vt;yt++)et[yt]=n.COLOR_ATTACHMENT0+yt;et.length=Et.length,ot=!0}}else et[0]!==n.BACK&&(et[0]=n.BACK,ot=!0);ot&&n.drawBuffers(et)}function A(U){return g!==U?(n.useProgram(U),g=U,!0):!1}const R={[qi]:n.FUNC_ADD,[V_]:n.FUNC_SUBTRACT,[G_]:n.FUNC_REVERSE_SUBTRACT};R[W_]=n.MIN,R[X_]=n.MAX;const X={[q_]:n.ZERO,[Y_]:n.ONE,[j_]:n.SRC_COLOR,[_l]:n.SRC_ALPHA,[tg]:n.SRC_ALPHA_SATURATE,[J_]:n.DST_COLOR,[$_]:n.DST_ALPHA,[K_]:n.ONE_MINUS_SRC_COLOR,[gl]:n.ONE_MINUS_SRC_ALPHA,[Q_]:n.ONE_MINUS_DST_COLOR,[Z_]:n.ONE_MINUS_DST_ALPHA,[eg]:n.CONSTANT_COLOR,[ng]:n.ONE_MINUS_CONSTANT_COLOR,[ig]:n.CONSTANT_ALPHA,[sg]:n.ONE_MINUS_CONSTANT_ALPHA};function T(U,vt,et,ot,Et,yt,Vt,_e,Re,re){if(U===wi){v===!0&&(It(n.BLEND),v=!1);return}if(v===!1&&(mt(n.BLEND),v=!0),U!==H_){if(U!==m||re!==E){if((f!==qi||x!==qi)&&(n.blendEquation(n.FUNC_ADD),f=qi,x=qi),re)switch(U){case Ps:n.blendFuncSeparate(n.ONE,n.ONE_MINUS_SRC_ALPHA,n.ONE,n.ONE_MINUS_SRC_ALPHA);break;case zu:n.blendFunc(n.ONE,n.ONE);break;case ku:n.blendFuncSeparate(n.ZERO,n.ONE_MINUS_SRC_COLOR,n.ZERO,n.ONE);break;case Hu:n.blendFuncSeparate(n.ZERO,n.SRC_COLOR,n.ZERO,n.SRC_ALPHA);break;default:console.error("THREE.WebGLState: Invalid blending: ",U);break}else switch(U){case Ps:n.blendFuncSeparate(n.SRC_ALPHA,n.ONE_MINUS_SRC_ALPHA,n.ONE,n.ONE_MINUS_SRC_ALPHA);break;case zu:n.blendFunc(n.SRC_ALPHA,n.ONE);break;case ku:n.blendFuncSeparate(n.ZERO,n.ONE_MINUS_SRC_COLOR,n.ZERO,n.ONE);break;case Hu:n.blendFunc(n.ZERO,n.SRC_COLOR);break;default:console.error("THREE.WebGLState: Invalid blending: ",U);break}w=null,b=null,B=null,P=null,D.set(0,0,0),N=0,m=U,E=re}return}Et=Et||vt,yt=yt||et,Vt=Vt||ot,(vt!==f||Et!==x)&&(n.blendEquationSeparate(R[vt],R[Et]),f=vt,x=Et),(et!==w||ot!==b||yt!==B||Vt!==P)&&(n.blendFuncSeparate(X[et],X[ot],X[yt],X[Vt]),w=et,b=ot,B=yt,P=Vt),(_e.equals(D)===!1||Re!==N)&&(n.blendColor(_e.r,_e.g,_e.b,Re),D.copy(_e),N=Re),m=U,E=!1}function nt(U,vt){U.side===In?It(n.CULL_FACE):mt(n.CULL_FACE);let et=U.side===Ye;vt&&(et=!et),Z(et),U.blending===Ps&&U.transparent===!1?T(wi):T(U.blending,U.blendEquation,U.blendSrc,U.blendDst,U.blendEquationAlpha,U.blendSrcAlpha,U.blendDstAlpha,U.blendColor,U.blendAlpha,U.premultipliedAlpha),o.setFunc(U.depthFunc),o.setTest(U.depthTest),o.setMask(U.depthWrite),r.setMask(U.colorWrite);const ot=U.stencilWrite;a.setTest(ot),ot&&(a.setMask(U.stencilWriteMask),a.setFunc(U.stencilFunc,U.stencilRef,U.stencilFuncMask),a.setOp(U.stencilFail,U.stencilZFail,U.stencilZPass)),rt(U.polygonOffset,U.polygonOffsetFactor,U.polygonOffsetUnits),U.alphaToCoverage===!0?mt(n.SAMPLE_ALPHA_TO_COVERAGE):It(n.SAMPLE_ALPHA_TO_COVERAGE)}function Z(U){M!==U&&(U?n.frontFace(n.CW):n.frontFace(n.CCW),M=U)}function st(U){U!==B_?(mt(n.CULL_FACE),U!==L&&(U===Bu?n.cullFace(n.BACK):U===z_?n.cullFace(n.FRONT):n.cullFace(n.FRONT_AND_BACK))):It(n.CULL_FACE),L=U}function tt(U){U!==J&&(H&&n.lineWidth(U),J=U)}function rt(U,vt,et){U?(mt(n.POLYGON_OFFSET_FILL),(C!==vt||k!==et)&&(n.polygonOffset(vt,et),C=vt,k=et)):It(n.POLYGON_OFFSET_FILL)}function V(U){U?mt(n.SCISSOR_TEST):It(n.SCISSOR_TEST)}function S(U){U===void 0&&(U=n.TEXTURE0+Y-1),at!==U&&(n.activeTexture(U),at=U)}function _(U,vt,et){et===void 0&&(at===null?et=n.TEXTURE0+Y-1:et=at);let ot=dt[et];ot===void 0&&(ot={type:void 0,texture:void 0},dt[et]=ot),(ot.type!==U||ot.texture!==vt)&&(at!==et&&(n.activeTexture(et),at=et),n.bindTexture(U,vt||Tt[U]),ot.type=U,ot.texture=vt)}function I(){const U=dt[at];U!==void 0&&U.type!==void 0&&(n.bindTexture(U.type,null),U.type=void 0,U.texture=void 0)}function W(){try{n.compressedTexImage2D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function Q(){try{n.compressedTexImage3D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function $(){try{n.texSubImage2D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function ht(){try{n.texSubImage3D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function ct(){try{n.compressedTexSubImage2D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function pt(){try{n.compressedTexSubImage3D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function Ft(){try{n.texStorage2D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function lt(){try{n.texStorage3D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function St(){try{n.texImage2D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function Lt(){try{n.texImage3D.apply(n,arguments)}catch(U){console.error("THREE.WebGLState:",U)}}function At(U){ee.equals(U)===!1&&(n.scissor(U.x,U.y,U.z,U.w),ee.copy(U))}function gt(U){it.equals(U)===!1&&(n.viewport(U.x,U.y,U.z,U.w),it.copy(U))}function Kt(U,vt){let et=u.get(vt);et===void 0&&(et=new WeakMap,u.set(vt,et));let ot=et.get(U);ot===void 0&&(ot=n.getUniformBlockIndex(vt,U.name),et.set(U,ot))}function zt(U,vt){const ot=u.get(vt).get(U);l.get(vt)!==ot&&(n.uniformBlockBinding(vt,ot,U.__bindingPointIndex),l.set(vt,ot))}function he(){n.disable(n.BLEND),n.disable(n.CULL_FACE),n.disable(n.DEPTH_TEST),n.disable(n.POLYGON_OFFSET_FILL),n.disable(n.SCISSOR_TEST),n.disable(n.STENCIL_TEST),n.disable(n.SAMPLE_ALPHA_TO_COVERAGE),n.blendEquation(n.FUNC_ADD),n.blendFunc(n.ONE,n.ZERO),n.blendFuncSeparate(n.ONE,n.ZERO,n.ONE,n.ZERO),n.blendColor(0,0,0,0),n.colorMask(!0,!0,!0,!0),n.clearColor(0,0,0,0),n.depthMask(!0),n.depthFunc(n.LESS),o.setReversed(!1),n.clearDepth(1),n.stencilMask(4294967295),n.stencilFunc(n.ALWAYS,0,4294967295),n.stencilOp(n.KEEP,n.KEEP,n.KEEP),n.clearStencil(0),n.cullFace(n.BACK),n.frontFace(n.CCW),n.polygonOffset(0,0),n.activeTexture(n.TEXTURE0),n.bindFramebuffer(n.FRAMEBUFFER,null),n.bindFramebuffer(n.DRAW_FRAMEBUFFER,null),n.bindFramebuffer(n.READ_FRAMEBUFFER,null),n.useProgram(null),n.lineWidth(1),n.scissor(0,0,n.canvas.width,n.canvas.height),n.viewport(0,0,n.canvas.width,n.canvas.height),c={},at=null,dt={},h={},d=new WeakMap,p=[],g=null,v=!1,m=null,f=null,w=null,b=null,x=null,B=null,P=null,D=new $t(0,0,0),N=0,E=!1,M=null,L=null,J=null,C=null,k=null,ee.set(0,0,n.canvas.width,n.canvas.height),it.set(0,0,n.canvas.width,n.canvas.height),r.reset(),o.reset(),a.reset()}return{buffers:{color:r,depth:o,stencil:a},enable:mt,disable:It,bindFramebuffer:Nt,drawBuffers:Yt,useProgram:A,setBlending:T,setMaterial:nt,setFlipSided:Z,setCullFace:st,setLineWidth:tt,setPolygonOffset:rt,setScissorTest:V,activeTexture:S,bindTexture:_,unbindTexture:I,compressedTexImage2D:W,compressedTexImage3D:Q,texImage2D:St,texImage3D:Lt,updateUBOMapping:Kt,uniformBlockBinding:zt,texStorage2D:Ft,texStorage3D:lt,texSubImage2D:$,texSubImage3D:ht,compressedTexSubImage2D:ct,compressedTexSubImage3D:pt,scissor:At,viewport:gt,reset:he}}function Nh(n,t,e,i){const s=RM(i);switch(e){case yd:return n*t;case Sd:return n*t;case Ed:return n*t*2;case Ic:return n*t/s.components*s.byteLength;case Uc:return n*t/s.components*s.byteLength;case bd:return n*t*2/s.components*s.byteLength;case Nc:return n*t*2/s.components*s.byteLength;case Md:return n*t*3/s.components*s.byteLength;case yn:return n*t*4/s.components*s.byteLength;case Oc:return n*t*4/s.components*s.byteLength;case go:case vo:return Math.floor((n+3)/4)*Math.floor((t+3)/4)*8;case xo:case yo:return Math.floor((n+3)/4)*Math.floor((t+3)/4)*16;case Pl:case Ll:return Math.max(n,16)*Math.max(t,8)/4;case Cl:case Dl:return Math.max(n,8)*Math.max(t,8)/2;case Il:case Ul:return Math.floor((n+3)/4)*Math.floor((t+3)/4)*8;case Nl:return Math.floor((n+3)/4)*Math.floor((t+3)/4)*16;case Ol:return Math.floor((n+3)/4)*Math.floor((t+3)/4)*16;case Fl:return Math.floor((n+4)/5)*Math.floor((t+3)/4)*16;case Bl:return Math.floor((n+4)/5)*Math.floor((t+4)/5)*16;case zl:return Math.floor((n+5)/6)*Math.floor((t+4)/5)*16;case kl:return Math.floor((n+5)/6)*Math.floor((t+5)/6)*16;case Hl:return Math.floor((n+7)/8)*Math.floor((t+4)/5)*16;case Vl:return Math.floor((n+7)/8)*Math.floor((t+5)/6)*16;case Gl:return Math.floor((n+7)/8)*Math.floor((t+7)/8)*16;case Wl:return Math.floor((n+9)/10)*Math.floor((t+4)/5)*16;case Xl:return Math.floor((n+9)/10)*Math.floor((t+5)/6)*16;case ql:return Math.floor((n+9)/10)*Math.floor((t+7)/8)*16;case Yl:return Math.floor((n+9)/10)*Math.floor((t+9)/10)*16;case jl:return Math.floor((n+11)/12)*Math.floor((t+9)/10)*16;case Kl:return Math.floor((n+11)/12)*Math.floor((t+11)/12)*16;case Mo:case $l:case Zl:return Math.ceil(n/4)*Math.ceil(t/4)*16;case Td:case Jl:return Math.ceil(n/4)*Math.ceil(t/4)*8;case Ql:case tc:return Math.ceil(n/4)*Math.ceil(t/4)*16}throw new Error(`Unable to determine texture byte length for ${e} format.`)}function RM(n){switch(n){case ui:case gd:return{byteLength:1,components:1};case br:case vd:case Cr:return{byteLength:2,components:1};case Dc:case Lc:return{byteLength:2,components:4};case es:case Pc:case On:return{byteLength:4,components:1};case xd:return{byteLength:4,components:3}}throw new Error(`Unknown texture type ${n}.`)}function CM(n,t,e,i,s,r,o){const a=t.has("WEBGL_multisampled_render_to_texture")?t.get("WEBGL_multisampled_render_to_texture"):null,l=typeof navigator>"u"?!1:/OculusBrowser/g.test(navigator.userAgent),u=new kt,c=new WeakMap;let h;const d=new WeakMap;let p=!1;try{p=typeof OffscreenCanvas<"u"&&new OffscreenCanvas(1,1).getContext("2d")!==null}catch{}function g(S,_){return p?new OffscreenCanvas(S,_):zo("canvas")}function v(S,_,I){let W=1;const Q=V(S);if((Q.width>I||Q.height>I)&&(W=I/Math.max(Q.width,Q.height)),W<1)if(typeof HTMLImageElement<"u"&&S instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&S instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&S instanceof ImageBitmap||typeof VideoFrame<"u"&&S instanceof VideoFrame){const $=Math.floor(W*Q.width),ht=Math.floor(W*Q.height);h===void 0&&(h=g($,ht));const ct=_?g($,ht):h;return ct.width=$,ct.height=ht,ct.getContext("2d").drawImage(S,0,0,$,ht),console.warn("THREE.WebGLRenderer: Texture has been resized from ("+Q.width+"x"+Q.height+") to ("+$+"x"+ht+")."),ct}else return"data"in S&&console.warn("THREE.WebGLRenderer: Image in DataTexture is too big ("+Q.width+"x"+Q.height+")."),S;return S}function m(S){return S.generateMipmaps}function f(S){n.generateMipmap(S)}function w(S){return S.isWebGLCubeRenderTarget?n.TEXTURE_CUBE_MAP:S.isWebGL3DRenderTarget?n.TEXTURE_3D:S.isWebGLArrayRenderTarget||S.isCompressedArrayTexture?n.TEXTURE_2D_ARRAY:n.TEXTURE_2D}function b(S,_,I,W,Q=!1){if(S!==null){if(n[S]!==void 0)return n[S];console.warn("THREE.WebGLRenderer: Attempt to use non-existing WebGL internal format '"+S+"'")}let $=_;if(_===n.RED&&(I===n.FLOAT&&($=n.R32F),I===n.HALF_FLOAT&&($=n.R16F),I===n.UNSIGNED_BYTE&&($=n.R8)),_===n.RED_INTEGER&&(I===n.UNSIGNED_BYTE&&($=n.R8UI),I===n.UNSIGNED_SHORT&&($=n.R16UI),I===n.UNSIGNED_INT&&($=n.R32UI),I===n.BYTE&&($=n.R8I),I===n.SHORT&&($=n.R16I),I===n.INT&&($=n.R32I)),_===n.RG&&(I===n.FLOAT&&($=n.RG32F),I===n.HALF_FLOAT&&($=n.RG16F),I===n.UNSIGNED_BYTE&&($=n.RG8)),_===n.RG_INTEGER&&(I===n.UNSIGNED_BYTE&&($=n.RG8UI),I===n.UNSIGNED_SHORT&&($=n.RG16UI),I===n.UNSIGNED_INT&&($=n.RG32UI),I===n.BYTE&&($=n.RG8I),I===n.SHORT&&($=n.RG16I),I===n.INT&&($=n.RG32I)),_===n.RGB_INTEGER&&(I===n.UNSIGNED_BYTE&&($=n.RGB8UI),I===n.UNSIGNED_SHORT&&($=n.RGB16UI),I===n.UNSIGNED_INT&&($=n.RGB32UI),I===n.BYTE&&($=n.RGB8I),I===n.SHORT&&($=n.RGB16I),I===n.INT&&($=n.RGB32I)),_===n.RGBA_INTEGER&&(I===n.UNSIGNED_BYTE&&($=n.RGBA8UI),I===n.UNSIGNED_SHORT&&($=n.RGBA16UI),I===n.UNSIGNED_INT&&($=n.RGBA32UI),I===n.BYTE&&($=n.RGBA8I),I===n.SHORT&&($=n.RGBA16I),I===n.INT&&($=n.RGBA32I)),_===n.RGB&&I===n.UNSIGNED_INT_5_9_9_9_REV&&($=n.RGB9_E5),_===n.RGBA){const ht=Q?ia:Jt.getTransfer(W);I===n.FLOAT&&($=n.RGBA32F),I===n.HALF_FLOAT&&($=n.RGBA16F),I===n.UNSIGNED_BYTE&&($=ht===ae?n.SRGB8_ALPHA8:n.RGBA8),I===n.UNSIGNED_SHORT_4_4_4_4&&($=n.RGBA4),I===n.UNSIGNED_SHORT_5_5_5_1&&($=n.RGB5_A1)}return($===n.R16F||$===n.R32F||$===n.RG16F||$===n.RG32F||$===n.RGBA16F||$===n.RGBA32F)&&t.get("EXT_color_buffer_float"),$}function x(S,_){let I;return S?_===null||_===es||_===Bs?I=n.DEPTH24_STENCIL8:_===On?I=n.DEPTH32F_STENCIL8:_===br&&(I=n.DEPTH24_STENCIL8,console.warn("DepthTexture: 16 bit depth attachment is not supported with stencil. Using 24-bit attachment.")):_===null||_===es||_===Bs?I=n.DEPTH_COMPONENT24:_===On?I=n.DEPTH_COMPONENT32F:_===br&&(I=n.DEPTH_COMPONENT16),I}function B(S,_){return m(S)===!0||S.isFramebufferTexture&&S.minFilter!==Je&&S.minFilter!==Nn?Math.log2(Math.max(_.width,_.height))+1:S.mipmaps!==void 0&&S.mipmaps.length>0?S.mipmaps.length:S.isCompressedTexture&&Array.isArray(S.image)?_.mipmaps.length:1}function P(S){const _=S.target;_.removeEventListener("dispose",P),N(_),_.isVideoTexture&&c.delete(_)}function D(S){const _=S.target;_.removeEventListener("dispose",D),M(_)}function N(S){const _=i.get(S);if(_.__webglInit===void 0)return;const I=S.source,W=d.get(I);if(W){const Q=W[_.__cacheKey];Q.usedTimes--,Q.usedTimes===0&&E(S),Object.keys(W).length===0&&d.delete(I)}i.remove(S)}function E(S){const _=i.get(S);n.deleteTexture(_.__webglTexture);const I=S.source,W=d.get(I);delete W[_.__cacheKey],o.memory.textures--}function M(S){const _=i.get(S);if(S.depthTexture&&(S.depthTexture.dispose(),i.remove(S.depthTexture)),S.isWebGLCubeRenderTarget)for(let W=0;W<6;W++){if(Array.isArray(_.__webglFramebuffer[W]))for(let Q=0;Q<_.__webglFramebuffer[W].length;Q++)n.deleteFramebuffer(_.__webglFramebuffer[W][Q]);else n.deleteFramebuffer(_.__webglFramebuffer[W]);_.__webglDepthbuffer&&n.deleteRenderbuffer(_.__webglDepthbuffer[W])}else{if(Array.isArray(_.__webglFramebuffer))for(let W=0;W<_.__webglFramebuffer.length;W++)n.deleteFramebuffer(_.__webglFramebuffer[W]);else n.deleteFramebuffer(_.__webglFramebuffer);if(_.__webglDepthbuffer&&n.deleteRenderbuffer(_.__webglDepthbuffer),_.__webglMultisampledFramebuffer&&n.deleteFramebuffer(_.__webglMultisampledFramebuffer),_.__webglColorRenderbuffer)for(let W=0;W<_.__webglColorRenderbuffer.length;W++)_.__webglColorRenderbuffer[W]&&n.deleteRenderbuffer(_.__webglColorRenderbuffer[W]);_.__webglDepthRenderbuffer&&n.deleteRenderbuffer(_.__webglDepthRenderbuffer)}const I=S.textures;for(let W=0,Q=I.length;W<Q;W++){const $=i.get(I[W]);$.__webglTexture&&(n.deleteTexture($.__webglTexture),o.memory.textures--),i.remove(I[W])}i.remove(S)}let L=0;function J(){L=0}function C(){const S=L;return S>=s.maxTextures&&console.warn("THREE.WebGLTextures: Trying to use "+S+" texture units while this GPU supports only "+s.maxTextures),L+=1,S}function k(S){const _=[];return _.push(S.wrapS),_.push(S.wrapT),_.push(S.wrapR||0),_.push(S.magFilter),_.push(S.minFilter),_.push(S.anisotropy),_.push(S.internalFormat),_.push(S.format),_.push(S.type),_.push(S.generateMipmaps),_.push(S.premultiplyAlpha),_.push(S.flipY),_.push(S.unpackAlignment),_.push(S.colorSpace),_.join()}function Y(S,_){const I=i.get(S);if(S.isVideoTexture&&tt(S),S.isRenderTargetTexture===!1&&S.version>0&&I.__version!==S.version){const W=S.image;if(W===null)console.warn("THREE.WebGLRenderer: Texture marked for update but no image data found.");else if(W.complete===!1)console.warn("THREE.WebGLRenderer: Texture marked for update but image is incomplete");else{it(I,S,_);return}}e.bindTexture(n.TEXTURE_2D,I.__webglTexture,n.TEXTURE0+_)}function H(S,_){const I=i.get(S);if(S.version>0&&I.__version!==S.version){it(I,S,_);return}e.bindTexture(n.TEXTURE_2D_ARRAY,I.__webglTexture,n.TEXTURE0+_)}function q(S,_){const I=i.get(S);if(S.version>0&&I.__version!==S.version){it(I,S,_);return}e.bindTexture(n.TEXTURE_3D,I.__webglTexture,n.TEXTURE0+_)}function z(S,_){const I=i.get(S);if(S.version>0&&I.__version!==S.version){ut(I,S,_);return}e.bindTexture(n.TEXTURE_CUBE_MAP,I.__webglTexture,n.TEXTURE0+_)}const at={[wl]:n.REPEAT,[$i]:n.CLAMP_TO_EDGE,[Rl]:n.MIRRORED_REPEAT},dt={[Je]:n.NEAREST,[pg]:n.NEAREST_MIPMAP_NEAREST,[Hr]:n.NEAREST_MIPMAP_LINEAR,[Nn]:n.LINEAR,[Ea]:n.LINEAR_MIPMAP_NEAREST,[Zi]:n.LINEAR_MIPMAP_LINEAR},bt={[vg]:n.NEVER,[bg]:n.ALWAYS,[xg]:n.LESS,[wd]:n.LEQUAL,[yg]:n.EQUAL,[Eg]:n.GEQUAL,[Mg]:n.GREATER,[Sg]:n.NOTEQUAL};function Ut(S,_){if(_.type===On&&t.has("OES_texture_float_linear")===!1&&(_.magFilter===Nn||_.magFilter===Ea||_.magFilter===Hr||_.magFilter===Zi||_.minFilter===Nn||_.minFilter===Ea||_.minFilter===Hr||_.minFilter===Zi)&&console.warn("THREE.WebGLRenderer: Unable to use linear filtering with floating point textures. OES_texture_float_linear not supported on this device."),n.texParameteri(S,n.TEXTURE_WRAP_S,at[_.wrapS]),n.texParameteri(S,n.TEXTURE_WRAP_T,at[_.wrapT]),(S===n.TEXTURE_3D||S===n.TEXTURE_2D_ARRAY)&&n.texParameteri(S,n.TEXTURE_WRAP_R,at[_.wrapR]),n.texParameteri(S,n.TEXTURE_MAG_FILTER,dt[_.magFilter]),n.texParameteri(S,n.TEXTURE_MIN_FILTER,dt[_.minFilter]),_.compareFunction&&(n.texParameteri(S,n.TEXTURE_COMPARE_MODE,n.COMPARE_REF_TO_TEXTURE),n.texParameteri(S,n.TEXTURE_COMPARE_FUNC,bt[_.compareFunction])),t.has("EXT_texture_filter_anisotropic")===!0){if(_.magFilter===Je||_.minFilter!==Hr&&_.minFilter!==Zi||_.type===On&&t.has("OES_texture_float_linear")===!1)return;if(_.anisotropy>1||i.get(_).__currentAnisotropy){const I=t.get("EXT_texture_filter_anisotropic");n.texParameterf(S,I.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(_.anisotropy,s.getMaxAnisotropy())),i.get(_).__currentAnisotropy=_.anisotropy}}}function ee(S,_){let I=!1;S.__webglInit===void 0&&(S.__webglInit=!0,_.addEventListener("dispose",P));const W=_.source;let Q=d.get(W);Q===void 0&&(Q={},d.set(W,Q));const $=k(_);if($!==S.__cacheKey){Q[$]===void 0&&(Q[$]={texture:n.createTexture(),usedTimes:0},o.memory.textures++,I=!0),Q[$].usedTimes++;const ht=Q[S.__cacheKey];ht!==void 0&&(Q[S.__cacheKey].usedTimes--,ht.usedTimes===0&&E(_)),S.__cacheKey=$,S.__webglTexture=Q[$].texture}return I}function it(S,_,I){let W=n.TEXTURE_2D;(_.isDataArrayTexture||_.isCompressedArrayTexture)&&(W=n.TEXTURE_2D_ARRAY),_.isData3DTexture&&(W=n.TEXTURE_3D);const Q=ee(S,_),$=_.source;e.bindTexture(W,S.__webglTexture,n.TEXTURE0+I);const ht=i.get($);if($.version!==ht.__version||Q===!0){e.activeTexture(n.TEXTURE0+I);const ct=Jt.getPrimaries(Jt.workingColorSpace),pt=_.colorSpace===Ei?null:Jt.getPrimaries(_.colorSpace),Ft=_.colorSpace===Ei||ct===pt?n.NONE:n.BROWSER_DEFAULT_WEBGL;n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,_.flipY),n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,_.premultiplyAlpha),n.pixelStorei(n.UNPACK_ALIGNMENT,_.unpackAlignment),n.pixelStorei(n.UNPACK_COLORSPACE_CONVERSION_WEBGL,Ft);let lt=v(_.image,!1,s.maxTextureSize);lt=rt(_,lt);const St=r.convert(_.format,_.colorSpace),Lt=r.convert(_.type);let At=b(_.internalFormat,St,Lt,_.colorSpace,_.isVideoTexture);Ut(W,_);let gt;const Kt=_.mipmaps,zt=_.isVideoTexture!==!0,he=ht.__version===void 0||Q===!0,U=$.dataReady,vt=B(_,lt);if(_.isDepthTexture)At=x(_.format===zs,_.type),he&&(zt?e.texStorage2D(n.TEXTURE_2D,1,At,lt.width,lt.height):e.texImage2D(n.TEXTURE_2D,0,At,lt.width,lt.height,0,St,Lt,null));else if(_.isDataTexture)if(Kt.length>0){zt&&he&&e.texStorage2D(n.TEXTURE_2D,vt,At,Kt[0].width,Kt[0].height);for(let et=0,ot=Kt.length;et<ot;et++)gt=Kt[et],zt?U&&e.texSubImage2D(n.TEXTURE_2D,et,0,0,gt.width,gt.height,St,Lt,gt.data):e.texImage2D(n.TEXTURE_2D,et,At,gt.width,gt.height,0,St,Lt,gt.data);_.generateMipmaps=!1}else zt?(he&&e.texStorage2D(n.TEXTURE_2D,vt,At,lt.width,lt.height),U&&e.texSubImage2D(n.TEXTURE_2D,0,0,0,lt.width,lt.height,St,Lt,lt.data)):e.texImage2D(n.TEXTURE_2D,0,At,lt.width,lt.height,0,St,Lt,lt.data);else if(_.isCompressedTexture)if(_.isCompressedArrayTexture){zt&&he&&e.texStorage3D(n.TEXTURE_2D_ARRAY,vt,At,Kt[0].width,Kt[0].height,lt.depth);for(let et=0,ot=Kt.length;et<ot;et++)if(gt=Kt[et],_.format!==yn)if(St!==null)if(zt){if(U)if(_.layerUpdates.size>0){const Et=Nh(gt.width,gt.height,_.format,_.type);for(const yt of _.layerUpdates){const Vt=gt.data.subarray(yt*Et/gt.data.BYTES_PER_ELEMENT,(yt+1)*Et/gt.data.BYTES_PER_ELEMENT);e.compressedTexSubImage3D(n.TEXTURE_2D_ARRAY,et,0,0,yt,gt.width,gt.height,1,St,Vt)}_.clearLayerUpdates()}else e.compressedTexSubImage3D(n.TEXTURE_2D_ARRAY,et,0,0,0,gt.width,gt.height,lt.depth,St,gt.data)}else e.compressedTexImage3D(n.TEXTURE_2D_ARRAY,et,At,gt.width,gt.height,lt.depth,0,gt.data,0,0);else console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()");else zt?U&&e.texSubImage3D(n.TEXTURE_2D_ARRAY,et,0,0,0,gt.width,gt.height,lt.depth,St,Lt,gt.data):e.texImage3D(n.TEXTURE_2D_ARRAY,et,At,gt.width,gt.height,lt.depth,0,St,Lt,gt.data)}else{zt&&he&&e.texStorage2D(n.TEXTURE_2D,vt,At,Kt[0].width,Kt[0].height);for(let et=0,ot=Kt.length;et<ot;et++)gt=Kt[et],_.format!==yn?St!==null?zt?U&&e.compressedTexSubImage2D(n.TEXTURE_2D,et,0,0,gt.width,gt.height,St,gt.data):e.compressedTexImage2D(n.TEXTURE_2D,et,At,gt.width,gt.height,0,gt.data):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()"):zt?U&&e.texSubImage2D(n.TEXTURE_2D,et,0,0,gt.width,gt.height,St,Lt,gt.data):e.texImage2D(n.TEXTURE_2D,et,At,gt.width,gt.height,0,St,Lt,gt.data)}else if(_.isDataArrayTexture)if(zt){if(he&&e.texStorage3D(n.TEXTURE_2D_ARRAY,vt,At,lt.width,lt.height,lt.depth),U)if(_.layerUpdates.size>0){const et=Nh(lt.width,lt.height,_.format,_.type);for(const ot of _.layerUpdates){const Et=lt.data.subarray(ot*et/lt.data.BYTES_PER_ELEMENT,(ot+1)*et/lt.data.BYTES_PER_ELEMENT);e.texSubImage3D(n.TEXTURE_2D_ARRAY,0,0,0,ot,lt.width,lt.height,1,St,Lt,Et)}_.clearLayerUpdates()}else e.texSubImage3D(n.TEXTURE_2D_ARRAY,0,0,0,0,lt.width,lt.height,lt.depth,St,Lt,lt.data)}else e.texImage3D(n.TEXTURE_2D_ARRAY,0,At,lt.width,lt.height,lt.depth,0,St,Lt,lt.data);else if(_.isData3DTexture)zt?(he&&e.texStorage3D(n.TEXTURE_3D,vt,At,lt.width,lt.height,lt.depth),U&&e.texSubImage3D(n.TEXTURE_3D,0,0,0,0,lt.width,lt.height,lt.depth,St,Lt,lt.data)):e.texImage3D(n.TEXTURE_3D,0,At,lt.width,lt.height,lt.depth,0,St,Lt,lt.data);else if(_.isFramebufferTexture){if(he)if(zt)e.texStorage2D(n.TEXTURE_2D,vt,At,lt.width,lt.height);else{let et=lt.width,ot=lt.height;for(let Et=0;Et<vt;Et++)e.texImage2D(n.TEXTURE_2D,Et,At,et,ot,0,St,Lt,null),et>>=1,ot>>=1}}else if(Kt.length>0){if(zt&&he){const et=V(Kt[0]);e.texStorage2D(n.TEXTURE_2D,vt,At,et.width,et.height)}for(let et=0,ot=Kt.length;et<ot;et++)gt=Kt[et],zt?U&&e.texSubImage2D(n.TEXTURE_2D,et,0,0,St,Lt,gt):e.texImage2D(n.TEXTURE_2D,et,At,St,Lt,gt);_.generateMipmaps=!1}else if(zt){if(he){const et=V(lt);e.texStorage2D(n.TEXTURE_2D,vt,At,et.width,et.height)}U&&e.texSubImage2D(n.TEXTURE_2D,0,0,0,St,Lt,lt)}else e.texImage2D(n.TEXTURE_2D,0,At,St,Lt,lt);m(_)&&f(W),ht.__version=$.version,_.onUpdate&&_.onUpdate(_)}S.__version=_.version}function ut(S,_,I){if(_.image.length!==6)return;const W=ee(S,_),Q=_.source;e.bindTexture(n.TEXTURE_CUBE_MAP,S.__webglTexture,n.TEXTURE0+I);const $=i.get(Q);if(Q.version!==$.__version||W===!0){e.activeTexture(n.TEXTURE0+I);const ht=Jt.getPrimaries(Jt.workingColorSpace),ct=_.colorSpace===Ei?null:Jt.getPrimaries(_.colorSpace),pt=_.colorSpace===Ei||ht===ct?n.NONE:n.BROWSER_DEFAULT_WEBGL;n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL,_.flipY),n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,_.premultiplyAlpha),n.pixelStorei(n.UNPACK_ALIGNMENT,_.unpackAlignment),n.pixelStorei(n.UNPACK_COLORSPACE_CONVERSION_WEBGL,pt);const Ft=_.isCompressedTexture||_.image[0].isCompressedTexture,lt=_.image[0]&&_.image[0].isDataTexture,St=[];for(let ot=0;ot<6;ot++)!Ft&&!lt?St[ot]=v(_.image[ot],!0,s.maxCubemapSize):St[ot]=lt?_.image[ot].image:_.image[ot],St[ot]=rt(_,St[ot]);const Lt=St[0],At=r.convert(_.format,_.colorSpace),gt=r.convert(_.type),Kt=b(_.internalFormat,At,gt,_.colorSpace),zt=_.isVideoTexture!==!0,he=$.__version===void 0||W===!0,U=Q.dataReady;let vt=B(_,Lt);Ut(n.TEXTURE_CUBE_MAP,_);let et;if(Ft){zt&&he&&e.texStorage2D(n.TEXTURE_CUBE_MAP,vt,Kt,Lt.width,Lt.height);for(let ot=0;ot<6;ot++){et=St[ot].mipmaps;for(let Et=0;Et<et.length;Et++){const yt=et[Et];_.format!==yn?At!==null?zt?U&&e.compressedTexSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,Et,0,0,yt.width,yt.height,At,yt.data):e.compressedTexImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,Et,Kt,yt.width,yt.height,0,yt.data):console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .setTextureCube()"):zt?U&&e.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,Et,0,0,yt.width,yt.height,At,gt,yt.data):e.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,Et,Kt,yt.width,yt.height,0,At,gt,yt.data)}}}else{if(et=_.mipmaps,zt&&he){et.length>0&&vt++;const ot=V(St[0]);e.texStorage2D(n.TEXTURE_CUBE_MAP,vt,Kt,ot.width,ot.height)}for(let ot=0;ot<6;ot++)if(lt){zt?U&&e.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,0,0,0,St[ot].width,St[ot].height,At,gt,St[ot].data):e.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,0,Kt,St[ot].width,St[ot].height,0,At,gt,St[ot].data);for(let Et=0;Et<et.length;Et++){const Vt=et[Et].image[ot].image;zt?U&&e.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,Et+1,0,0,Vt.width,Vt.height,At,gt,Vt.data):e.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,Et+1,Kt,Vt.width,Vt.height,0,At,gt,Vt.data)}}else{zt?U&&e.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,0,0,0,At,gt,St[ot]):e.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,0,Kt,At,gt,St[ot]);for(let Et=0;Et<et.length;Et++){const yt=et[Et];zt?U&&e.texSubImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,Et+1,0,0,At,gt,yt.image[ot]):e.texImage2D(n.TEXTURE_CUBE_MAP_POSITIVE_X+ot,Et+1,Kt,At,gt,yt.image[ot])}}}m(_)&&f(n.TEXTURE_CUBE_MAP),$.__version=Q.version,_.onUpdate&&_.onUpdate(_)}S.__version=_.version}function Tt(S,_,I,W,Q,$){const ht=r.convert(I.format,I.colorSpace),ct=r.convert(I.type),pt=b(I.internalFormat,ht,ct,I.colorSpace),Ft=i.get(_),lt=i.get(I);if(lt.__renderTarget=_,!Ft.__hasExternalTextures){const St=Math.max(1,_.width>>$),Lt=Math.max(1,_.height>>$);Q===n.TEXTURE_3D||Q===n.TEXTURE_2D_ARRAY?e.texImage3D(Q,$,pt,St,Lt,_.depth,0,ht,ct,null):e.texImage2D(Q,$,pt,St,Lt,0,ht,ct,null)}e.bindFramebuffer(n.FRAMEBUFFER,S),st(_)?a.framebufferTexture2DMultisampleEXT(n.FRAMEBUFFER,W,Q,lt.__webglTexture,0,Z(_)):(Q===n.TEXTURE_2D||Q>=n.TEXTURE_CUBE_MAP_POSITIVE_X&&Q<=n.TEXTURE_CUBE_MAP_NEGATIVE_Z)&&n.framebufferTexture2D(n.FRAMEBUFFER,W,Q,lt.__webglTexture,$),e.bindFramebuffer(n.FRAMEBUFFER,null)}function mt(S,_,I){if(n.bindRenderbuffer(n.RENDERBUFFER,S),_.depthBuffer){const W=_.depthTexture,Q=W&&W.isDepthTexture?W.type:null,$=x(_.stencilBuffer,Q),ht=_.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT,ct=Z(_);st(_)?a.renderbufferStorageMultisampleEXT(n.RENDERBUFFER,ct,$,_.width,_.height):I?n.renderbufferStorageMultisample(n.RENDERBUFFER,ct,$,_.width,_.height):n.renderbufferStorage(n.RENDERBUFFER,$,_.width,_.height),n.framebufferRenderbuffer(n.FRAMEBUFFER,ht,n.RENDERBUFFER,S)}else{const W=_.textures;for(let Q=0;Q<W.length;Q++){const $=W[Q],ht=r.convert($.format,$.colorSpace),ct=r.convert($.type),pt=b($.internalFormat,ht,ct,$.colorSpace),Ft=Z(_);I&&st(_)===!1?n.renderbufferStorageMultisample(n.RENDERBUFFER,Ft,pt,_.width,_.height):st(_)?a.renderbufferStorageMultisampleEXT(n.RENDERBUFFER,Ft,pt,_.width,_.height):n.renderbufferStorage(n.RENDERBUFFER,pt,_.width,_.height)}}n.bindRenderbuffer(n.RENDERBUFFER,null)}function It(S,_){if(_&&_.isWebGLCubeRenderTarget)throw new Error("Depth Texture with cube render targets is not supported");if(e.bindFramebuffer(n.FRAMEBUFFER,S),!(_.depthTexture&&_.depthTexture.isDepthTexture))throw new Error("renderTarget.depthTexture must be an instance of THREE.DepthTexture");const W=i.get(_.depthTexture);W.__renderTarget=_,(!W.__webglTexture||_.depthTexture.image.width!==_.width||_.depthTexture.image.height!==_.height)&&(_.depthTexture.image.width=_.width,_.depthTexture.image.height=_.height,_.depthTexture.needsUpdate=!0),Y(_.depthTexture,0);const Q=W.__webglTexture,$=Z(_);if(_.depthTexture.format===Ds)st(_)?a.framebufferTexture2DMultisampleEXT(n.FRAMEBUFFER,n.DEPTH_ATTACHMENT,n.TEXTURE_2D,Q,0,$):n.framebufferTexture2D(n.FRAMEBUFFER,n.DEPTH_ATTACHMENT,n.TEXTURE_2D,Q,0);else if(_.depthTexture.format===zs)st(_)?a.framebufferTexture2DMultisampleEXT(n.FRAMEBUFFER,n.DEPTH_STENCIL_ATTACHMENT,n.TEXTURE_2D,Q,0,$):n.framebufferTexture2D(n.FRAMEBUFFER,n.DEPTH_STENCIL_ATTACHMENT,n.TEXTURE_2D,Q,0);else throw new Error("Unknown depthTexture format")}function Nt(S){const _=i.get(S),I=S.isWebGLCubeRenderTarget===!0;if(_.__boundDepthTexture!==S.depthTexture){const W=S.depthTexture;if(_.__depthDisposeCallback&&_.__depthDisposeCallback(),W){const Q=()=>{delete _.__boundDepthTexture,delete _.__depthDisposeCallback,W.removeEventListener("dispose",Q)};W.addEventListener("dispose",Q),_.__depthDisposeCallback=Q}_.__boundDepthTexture=W}if(S.depthTexture&&!_.__autoAllocateDepthBuffer){if(I)throw new Error("target.depthTexture not supported in Cube render targets");It(_.__webglFramebuffer,S)}else if(I){_.__webglDepthbuffer=[];for(let W=0;W<6;W++)if(e.bindFramebuffer(n.FRAMEBUFFER,_.__webglFramebuffer[W]),_.__webglDepthbuffer[W]===void 0)_.__webglDepthbuffer[W]=n.createRenderbuffer(),mt(_.__webglDepthbuffer[W],S,!1);else{const Q=S.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT,$=_.__webglDepthbuffer[W];n.bindRenderbuffer(n.RENDERBUFFER,$),n.framebufferRenderbuffer(n.FRAMEBUFFER,Q,n.RENDERBUFFER,$)}}else if(e.bindFramebuffer(n.FRAMEBUFFER,_.__webglFramebuffer),_.__webglDepthbuffer===void 0)_.__webglDepthbuffer=n.createRenderbuffer(),mt(_.__webglDepthbuffer,S,!1);else{const W=S.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT,Q=_.__webglDepthbuffer;n.bindRenderbuffer(n.RENDERBUFFER,Q),n.framebufferRenderbuffer(n.FRAMEBUFFER,W,n.RENDERBUFFER,Q)}e.bindFramebuffer(n.FRAMEBUFFER,null)}function Yt(S,_,I){const W=i.get(S);_!==void 0&&Tt(W.__webglFramebuffer,S,S.texture,n.COLOR_ATTACHMENT0,n.TEXTURE_2D,0),I!==void 0&&Nt(S)}function A(S){const _=S.texture,I=i.get(S),W=i.get(_);S.addEventListener("dispose",D);const Q=S.textures,$=S.isWebGLCubeRenderTarget===!0,ht=Q.length>1;if(ht||(W.__webglTexture===void 0&&(W.__webglTexture=n.createTexture()),W.__version=_.version,o.memory.textures++),$){I.__webglFramebuffer=[];for(let ct=0;ct<6;ct++)if(_.mipmaps&&_.mipmaps.length>0){I.__webglFramebuffer[ct]=[];for(let pt=0;pt<_.mipmaps.length;pt++)I.__webglFramebuffer[ct][pt]=n.createFramebuffer()}else I.__webglFramebuffer[ct]=n.createFramebuffer()}else{if(_.mipmaps&&_.mipmaps.length>0){I.__webglFramebuffer=[];for(let ct=0;ct<_.mipmaps.length;ct++)I.__webglFramebuffer[ct]=n.createFramebuffer()}else I.__webglFramebuffer=n.createFramebuffer();if(ht)for(let ct=0,pt=Q.length;ct<pt;ct++){const Ft=i.get(Q[ct]);Ft.__webglTexture===void 0&&(Ft.__webglTexture=n.createTexture(),o.memory.textures++)}if(S.samples>0&&st(S)===!1){I.__webglMultisampledFramebuffer=n.createFramebuffer(),I.__webglColorRenderbuffer=[],e.bindFramebuffer(n.FRAMEBUFFER,I.__webglMultisampledFramebuffer);for(let ct=0;ct<Q.length;ct++){const pt=Q[ct];I.__webglColorRenderbuffer[ct]=n.createRenderbuffer(),n.bindRenderbuffer(n.RENDERBUFFER,I.__webglColorRenderbuffer[ct]);const Ft=r.convert(pt.format,pt.colorSpace),lt=r.convert(pt.type),St=b(pt.internalFormat,Ft,lt,pt.colorSpace,S.isXRRenderTarget===!0),Lt=Z(S);n.renderbufferStorageMultisample(n.RENDERBUFFER,Lt,St,S.width,S.height),n.framebufferRenderbuffer(n.FRAMEBUFFER,n.COLOR_ATTACHMENT0+ct,n.RENDERBUFFER,I.__webglColorRenderbuffer[ct])}n.bindRenderbuffer(n.RENDERBUFFER,null),S.depthBuffer&&(I.__webglDepthRenderbuffer=n.createRenderbuffer(),mt(I.__webglDepthRenderbuffer,S,!0)),e.bindFramebuffer(n.FRAMEBUFFER,null)}}if($){e.bindTexture(n.TEXTURE_CUBE_MAP,W.__webglTexture),Ut(n.TEXTURE_CUBE_MAP,_);for(let ct=0;ct<6;ct++)if(_.mipmaps&&_.mipmaps.length>0)for(let pt=0;pt<_.mipmaps.length;pt++)Tt(I.__webglFramebuffer[ct][pt],S,_,n.COLOR_ATTACHMENT0,n.TEXTURE_CUBE_MAP_POSITIVE_X+ct,pt);else Tt(I.__webglFramebuffer[ct],S,_,n.COLOR_ATTACHMENT0,n.TEXTURE_CUBE_MAP_POSITIVE_X+ct,0);m(_)&&f(n.TEXTURE_CUBE_MAP),e.unbindTexture()}else if(ht){for(let ct=0,pt=Q.length;ct<pt;ct++){const Ft=Q[ct],lt=i.get(Ft);e.bindTexture(n.TEXTURE_2D,lt.__webglTexture),Ut(n.TEXTURE_2D,Ft),Tt(I.__webglFramebuffer,S,Ft,n.COLOR_ATTACHMENT0+ct,n.TEXTURE_2D,0),m(Ft)&&f(n.TEXTURE_2D)}e.unbindTexture()}else{let ct=n.TEXTURE_2D;if((S.isWebGL3DRenderTarget||S.isWebGLArrayRenderTarget)&&(ct=S.isWebGL3DRenderTarget?n.TEXTURE_3D:n.TEXTURE_2D_ARRAY),e.bindTexture(ct,W.__webglTexture),Ut(ct,_),_.mipmaps&&_.mipmaps.length>0)for(let pt=0;pt<_.mipmaps.length;pt++)Tt(I.__webglFramebuffer[pt],S,_,n.COLOR_ATTACHMENT0,ct,pt);else Tt(I.__webglFramebuffer,S,_,n.COLOR_ATTACHMENT0,ct,0);m(_)&&f(ct),e.unbindTexture()}S.depthBuffer&&Nt(S)}function R(S){const _=S.textures;for(let I=0,W=_.length;I<W;I++){const Q=_[I];if(m(Q)){const $=w(S),ht=i.get(Q).__webglTexture;e.bindTexture($,ht),f($),e.unbindTexture()}}}const X=[],T=[];function nt(S){if(S.samples>0){if(st(S)===!1){const _=S.textures,I=S.width,W=S.height;let Q=n.COLOR_BUFFER_BIT;const $=S.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT,ht=i.get(S),ct=_.length>1;if(ct)for(let pt=0;pt<_.length;pt++)e.bindFramebuffer(n.FRAMEBUFFER,ht.__webglMultisampledFramebuffer),n.framebufferRenderbuffer(n.FRAMEBUFFER,n.COLOR_ATTACHMENT0+pt,n.RENDERBUFFER,null),e.bindFramebuffer(n.FRAMEBUFFER,ht.__webglFramebuffer),n.framebufferTexture2D(n.DRAW_FRAMEBUFFER,n.COLOR_ATTACHMENT0+pt,n.TEXTURE_2D,null,0);e.bindFramebuffer(n.READ_FRAMEBUFFER,ht.__webglMultisampledFramebuffer),e.bindFramebuffer(n.DRAW_FRAMEBUFFER,ht.__webglFramebuffer);for(let pt=0;pt<_.length;pt++){if(S.resolveDepthBuffer&&(S.depthBuffer&&(Q|=n.DEPTH_BUFFER_BIT),S.stencilBuffer&&S.resolveStencilBuffer&&(Q|=n.STENCIL_BUFFER_BIT)),ct){n.framebufferRenderbuffer(n.READ_FRAMEBUFFER,n.COLOR_ATTACHMENT0,n.RENDERBUFFER,ht.__webglColorRenderbuffer[pt]);const Ft=i.get(_[pt]).__webglTexture;n.framebufferTexture2D(n.DRAW_FRAMEBUFFER,n.COLOR_ATTACHMENT0,n.TEXTURE_2D,Ft,0)}n.blitFramebuffer(0,0,I,W,0,0,I,W,Q,n.NEAREST),l===!0&&(X.length=0,T.length=0,X.push(n.COLOR_ATTACHMENT0+pt),S.depthBuffer&&S.resolveDepthBuffer===!1&&(X.push($),T.push($),n.invalidateFramebuffer(n.DRAW_FRAMEBUFFER,T)),n.invalidateFramebuffer(n.READ_FRAMEBUFFER,X))}if(e.bindFramebuffer(n.READ_FRAMEBUFFER,null),e.bindFramebuffer(n.DRAW_FRAMEBUFFER,null),ct)for(let pt=0;pt<_.length;pt++){e.bindFramebuffer(n.FRAMEBUFFER,ht.__webglMultisampledFramebuffer),n.framebufferRenderbuffer(n.FRAMEBUFFER,n.COLOR_ATTACHMENT0+pt,n.RENDERBUFFER,ht.__webglColorRenderbuffer[pt]);const Ft=i.get(_[pt]).__webglTexture;e.bindFramebuffer(n.FRAMEBUFFER,ht.__webglFramebuffer),n.framebufferTexture2D(n.DRAW_FRAMEBUFFER,n.COLOR_ATTACHMENT0+pt,n.TEXTURE_2D,Ft,0)}e.bindFramebuffer(n.DRAW_FRAMEBUFFER,ht.__webglMultisampledFramebuffer)}else if(S.depthBuffer&&S.resolveDepthBuffer===!1&&l){const _=S.stencilBuffer?n.DEPTH_STENCIL_ATTACHMENT:n.DEPTH_ATTACHMENT;n.invalidateFramebuffer(n.DRAW_FRAMEBUFFER,[_])}}}function Z(S){return Math.min(s.maxSamples,S.samples)}function st(S){const _=i.get(S);return S.samples>0&&t.has("WEBGL_multisampled_render_to_texture")===!0&&_.__useRenderToTexture!==!1}function tt(S){const _=o.render.frame;c.get(S)!==_&&(c.set(S,_),S.update())}function rt(S,_){const I=S.colorSpace,W=S.format,Q=S.type;return S.isCompressedTexture===!0||S.isVideoTexture===!0||I!==Hs&&I!==Ei&&(Jt.getTransfer(I)===ae?(W!==yn||Q!==ui)&&console.warn("THREE.WebGLTextures: sRGB encoded textures have to use RGBAFormat and UnsignedByteType."):console.error("THREE.WebGLTextures: Unsupported texture color space:",I)),_}function V(S){return typeof HTMLImageElement<"u"&&S instanceof HTMLImageElement?(u.width=S.naturalWidth||S.width,u.height=S.naturalHeight||S.height):typeof VideoFrame<"u"&&S instanceof VideoFrame?(u.width=S.displayWidth,u.height=S.displayHeight):(u.width=S.width,u.height=S.height),u}this.allocateTextureUnit=C,this.resetTextureUnits=J,this.setTexture2D=Y,this.setTexture2DArray=H,this.setTexture3D=q,this.setTextureCube=z,this.rebindTextures=Yt,this.setupRenderTarget=A,this.updateRenderTargetMipmap=R,this.updateMultisampleRenderTarget=nt,this.setupDepthRenderbuffer=Nt,this.setupFrameBufferTexture=Tt,this.useMultisampledRTT=st}function PM(n,t){function e(i,s=Ei){let r;const o=Jt.getTransfer(s);if(i===ui)return n.UNSIGNED_BYTE;if(i===Dc)return n.UNSIGNED_SHORT_4_4_4_4;if(i===Lc)return n.UNSIGNED_SHORT_5_5_5_1;if(i===xd)return n.UNSIGNED_INT_5_9_9_9_REV;if(i===gd)return n.BYTE;if(i===vd)return n.SHORT;if(i===br)return n.UNSIGNED_SHORT;if(i===Pc)return n.INT;if(i===es)return n.UNSIGNED_INT;if(i===On)return n.FLOAT;if(i===Cr)return n.HALF_FLOAT;if(i===yd)return n.ALPHA;if(i===Md)return n.RGB;if(i===yn)return n.RGBA;if(i===Sd)return n.LUMINANCE;if(i===Ed)return n.LUMINANCE_ALPHA;if(i===Ds)return n.DEPTH_COMPONENT;if(i===zs)return n.DEPTH_STENCIL;if(i===Ic)return n.RED;if(i===Uc)return n.RED_INTEGER;if(i===bd)return n.RG;if(i===Nc)return n.RG_INTEGER;if(i===Oc)return n.RGBA_INTEGER;if(i===go||i===vo||i===xo||i===yo)if(o===ae)if(r=t.get("WEBGL_compressed_texture_s3tc_srgb"),r!==null){if(i===go)return r.COMPRESSED_SRGB_S3TC_DXT1_EXT;if(i===vo)return r.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT;if(i===xo)return r.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT;if(i===yo)return r.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT}else return null;else if(r=t.get("WEBGL_compressed_texture_s3tc"),r!==null){if(i===go)return r.COMPRESSED_RGB_S3TC_DXT1_EXT;if(i===vo)return r.COMPRESSED_RGBA_S3TC_DXT1_EXT;if(i===xo)return r.COMPRESSED_RGBA_S3TC_DXT3_EXT;if(i===yo)return r.COMPRESSED_RGBA_S3TC_DXT5_EXT}else return null;if(i===Cl||i===Pl||i===Dl||i===Ll)if(r=t.get("WEBGL_compressed_texture_pvrtc"),r!==null){if(i===Cl)return r.COMPRESSED_RGB_PVRTC_4BPPV1_IMG;if(i===Pl)return r.COMPRESSED_RGB_PVRTC_2BPPV1_IMG;if(i===Dl)return r.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG;if(i===Ll)return r.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG}else return null;if(i===Il||i===Ul||i===Nl)if(r=t.get("WEBGL_compressed_texture_etc"),r!==null){if(i===Il||i===Ul)return o===ae?r.COMPRESSED_SRGB8_ETC2:r.COMPRESSED_RGB8_ETC2;if(i===Nl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:r.COMPRESSED_RGBA8_ETC2_EAC}else return null;if(i===Ol||i===Fl||i===Bl||i===zl||i===kl||i===Hl||i===Vl||i===Gl||i===Wl||i===Xl||i===ql||i===Yl||i===jl||i===Kl)if(r=t.get("WEBGL_compressed_texture_astc"),r!==null){if(i===Ol)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR:r.COMPRESSED_RGBA_ASTC_4x4_KHR;if(i===Fl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR:r.COMPRESSED_RGBA_ASTC_5x4_KHR;if(i===Bl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR:r.COMPRESSED_RGBA_ASTC_5x5_KHR;if(i===zl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR:r.COMPRESSED_RGBA_ASTC_6x5_KHR;if(i===kl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR:r.COMPRESSED_RGBA_ASTC_6x6_KHR;if(i===Hl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR:r.COMPRESSED_RGBA_ASTC_8x5_KHR;if(i===Vl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR:r.COMPRESSED_RGBA_ASTC_8x6_KHR;if(i===Gl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR:r.COMPRESSED_RGBA_ASTC_8x8_KHR;if(i===Wl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR:r.COMPRESSED_RGBA_ASTC_10x5_KHR;if(i===Xl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR:r.COMPRESSED_RGBA_ASTC_10x6_KHR;if(i===ql)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR:r.COMPRESSED_RGBA_ASTC_10x8_KHR;if(i===Yl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR:r.COMPRESSED_RGBA_ASTC_10x10_KHR;if(i===jl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR:r.COMPRESSED_RGBA_ASTC_12x10_KHR;if(i===Kl)return o===ae?r.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR:r.COMPRESSED_RGBA_ASTC_12x12_KHR}else return null;if(i===Mo||i===$l||i===Zl)if(r=t.get("EXT_texture_compression_bptc"),r!==null){if(i===Mo)return o===ae?r.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT:r.COMPRESSED_RGBA_BPTC_UNORM_EXT;if(i===$l)return r.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;if(i===Zl)return r.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT}else return null;if(i===Td||i===Jl||i===Ql||i===tc)if(r=t.get("EXT_texture_compression_rgtc"),r!==null){if(i===Mo)return r.COMPRESSED_RED_RGTC1_EXT;if(i===Jl)return r.COMPRESSED_SIGNED_RED_RGTC1_EXT;if(i===Ql)return r.COMPRESSED_RED_GREEN_RGTC2_EXT;if(i===tc)return r.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT}else return null;return i===Bs?n.UNSIGNED_INT_24_8:n[i]!==void 0?n[i]:null}return{convert:e}}class DM extends on{constructor(t=[]){super(),this.isArrayCamera=!0,this.cameras=t}}class or extends Ae{constructor(){super(),this.isGroup=!0,this.type="Group"}}const LM={type:"move"};class Za{constructor(){this._targetRay=null,this._grip=null,this._hand=null}getHandSpace(){return this._hand===null&&(this._hand=new or,this._hand.matrixAutoUpdate=!1,this._hand.visible=!1,this._hand.joints={},this._hand.inputState={pinching:!1}),this._hand}getTargetRaySpace(){return this._targetRay===null&&(this._targetRay=new or,this._targetRay.matrixAutoUpdate=!1,this._targetRay.visible=!1,this._targetRay.hasLinearVelocity=!1,this._targetRay.linearVelocity=new G,this._targetRay.hasAngularVelocity=!1,this._targetRay.angularVelocity=new G),this._targetRay}getGripSpace(){return this._grip===null&&(this._grip=new or,this._grip.matrixAutoUpdate=!1,this._grip.visible=!1,this._grip.hasLinearVelocity=!1,this._grip.linearVelocity=new G,this._grip.hasAngularVelocity=!1,this._grip.angularVelocity=new G),this._grip}dispatchEvent(t){return this._targetRay!==null&&this._targetRay.dispatchEvent(t),this._grip!==null&&this._grip.dispatchEvent(t),this._hand!==null&&this._hand.dispatchEvent(t),this}connect(t){if(t&&t.hand){const e=this._hand;if(e)for(const i of t.hand.values())this._getHandJoint(e,i)}return this.dispatchEvent({type:"connected",data:t}),this}disconnect(t){return this.dispatchEvent({type:"disconnected",data:t}),this._targetRay!==null&&(this._targetRay.visible=!1),this._grip!==null&&(this._grip.visible=!1),this._hand!==null&&(this._hand.visible=!1),this}update(t,e,i){let s=null,r=null,o=null;const a=this._targetRay,l=this._grip,u=this._hand;if(t&&e.session.visibilityState!=="visible-blurred"){if(u&&t.hand){o=!0;for(const v of t.hand.values()){const m=e.getJointPose(v,i),f=this._getHandJoint(u,v);m!==null&&(f.matrix.fromArray(m.transform.matrix),f.matrix.decompose(f.position,f.rotation,f.scale),f.matrixWorldNeedsUpdate=!0,f.jointRadius=m.radius),f.visible=m!==null}const c=u.joints["index-finger-tip"],h=u.joints["thumb-tip"],d=c.position.distanceTo(h.position),p=.02,g=.005;u.inputState.pinching&&d>p+g?(u.inputState.pinching=!1,this.dispatchEvent({type:"pinchend",handedness:t.handedness,target:this})):!u.inputState.pinching&&d<=p-g&&(u.inputState.pinching=!0,this.dispatchEvent({type:"pinchstart",handedness:t.handedness,target:this}))}else l!==null&&t.gripSpace&&(r=e.getPose(t.gripSpace,i),r!==null&&(l.matrix.fromArray(r.transform.matrix),l.matrix.decompose(l.position,l.rotation,l.scale),l.matrixWorldNeedsUpdate=!0,r.linearVelocity?(l.hasLinearVelocity=!0,l.linearVelocity.copy(r.linearVelocity)):l.hasLinearVelocity=!1,r.angularVelocity?(l.hasAngularVelocity=!0,l.angularVelocity.copy(r.angularVelocity)):l.hasAngularVelocity=!1));a!==null&&(s=e.getPose(t.targetRaySpace,i),s===null&&r!==null&&(s=r),s!==null&&(a.matrix.fromArray(s.transform.matrix),a.matrix.decompose(a.position,a.rotation,a.scale),a.matrixWorldNeedsUpdate=!0,s.linearVelocity?(a.hasLinearVelocity=!0,a.linearVelocity.copy(s.linearVelocity)):a.hasLinearVelocity=!1,s.angularVelocity?(a.hasAngularVelocity=!0,a.angularVelocity.copy(s.angularVelocity)):a.hasAngularVelocity=!1,this.dispatchEvent(LM)))}return a!==null&&(a.visible=s!==null),l!==null&&(l.visible=r!==null),u!==null&&(u.visible=o!==null),this}_getHandJoint(t,e){if(t.joints[e.jointName]===void 0){const i=new or;i.matrixAutoUpdate=!1,i.visible=!1,t.joints[e.jointName]=i,t.add(i)}return t.joints[e.jointName]}}const IM=`
void main() {

	gl_Position = vec4( position, 1.0 );

}`,UM=`
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;

void main() {

	vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );

	if ( coord.x >= 1.0 ) {

		gl_FragDepth = texture( depthColor, vec3( coord.x - 1.0, coord.y, 1 ) ).r;

	} else {

		gl_FragDepth = texture( depthColor, vec3( coord.x, coord.y, 0 ) ).r;

	}

}`;class NM{constructor(){this.texture=null,this.mesh=null,this.depthNear=0,this.depthFar=0}init(t,e,i){if(this.texture===null){const s=new ze,r=t.properties.get(s);r.__webglTexture=e.texture,(e.depthNear!=i.depthNear||e.depthFar!=i.depthFar)&&(this.depthNear=e.depthNear,this.depthFar=e.depthFar),this.texture=s}}getMesh(t){if(this.texture!==null&&this.mesh===null){const e=t.cameras[0].viewport,i=new Li({vertexShader:IM,fragmentShader:UM,uniforms:{depthColor:{value:this.texture},depthWidth:{value:e.z},depthHeight:{value:e.w}}});this.mesh=new qe(new sa(20,20),i)}return this.mesh}reset(){this.texture=null,this.mesh=null}getDepthTexture(){return this.texture}}class OM extends rs{constructor(t,e){super();const i=this;let s=null,r=1,o=null,a="local-floor",l=1,u=null,c=null,h=null,d=null,p=null,g=null;const v=new NM,m=e.getContextAttributes();let f=null,w=null;const b=[],x=[],B=new kt;let P=null;const D=new on;D.viewport=new ge;const N=new on;N.viewport=new ge;const E=[D,N],M=new DM;let L=null,J=null;this.cameraAutoUpdate=!0,this.enabled=!1,this.isPresenting=!1,this.getController=function(it){let ut=b[it];return ut===void 0&&(ut=new Za,b[it]=ut),ut.getTargetRaySpace()},this.getControllerGrip=function(it){let ut=b[it];return ut===void 0&&(ut=new Za,b[it]=ut),ut.getGripSpace()},this.getHand=function(it){let ut=b[it];return ut===void 0&&(ut=new Za,b[it]=ut),ut.getHandSpace()};function C(it){const ut=x.indexOf(it.inputSource);if(ut===-1)return;const Tt=b[ut];Tt!==void 0&&(Tt.update(it.inputSource,it.frame,u||o),Tt.dispatchEvent({type:it.type,data:it.inputSource}))}function k(){s.removeEventListener("select",C),s.removeEventListener("selectstart",C),s.removeEventListener("selectend",C),s.removeEventListener("squeeze",C),s.removeEventListener("squeezestart",C),s.removeEventListener("squeezeend",C),s.removeEventListener("end",k),s.removeEventListener("inputsourceschange",Y);for(let it=0;it<b.length;it++){const ut=x[it];ut!==null&&(x[it]=null,b[it].disconnect(ut))}L=null,J=null,v.reset(),t.setRenderTarget(f),p=null,d=null,h=null,s=null,w=null,ee.stop(),i.isPresenting=!1,t.setPixelRatio(P),t.setSize(B.width,B.height,!1),i.dispatchEvent({type:"sessionend"})}this.setFramebufferScaleFactor=function(it){r=it,i.isPresenting===!0&&console.warn("THREE.WebXRManager: Cannot change framebuffer scale while presenting.")},this.setReferenceSpaceType=function(it){a=it,i.isPresenting===!0&&console.warn("THREE.WebXRManager: Cannot change reference space type while presenting.")},this.getReferenceSpace=function(){return u||o},this.setReferenceSpace=function(it){u=it},this.getBaseLayer=function(){return d!==null?d:p},this.getBinding=function(){return h},this.getFrame=function(){return g},this.getSession=function(){return s},this.setSession=async function(it){if(s=it,s!==null){if(f=t.getRenderTarget(),s.addEventListener("select",C),s.addEventListener("selectstart",C),s.addEventListener("selectend",C),s.addEventListener("squeeze",C),s.addEventListener("squeezestart",C),s.addEventListener("squeezeend",C),s.addEventListener("end",k),s.addEventListener("inputsourceschange",Y),m.xrCompatible!==!0&&await e.makeXRCompatible(),P=t.getPixelRatio(),t.getSize(B),s.renderState.layers===void 0){const ut={antialias:m.antialias,alpha:!0,depth:m.depth,stencil:m.stencil,framebufferScaleFactor:r};p=new XRWebGLLayer(s,e,ut),s.updateRenderState({baseLayer:p}),t.setPixelRatio(1),t.setSize(p.framebufferWidth,p.framebufferHeight,!1),w=new ns(p.framebufferWidth,p.framebufferHeight,{format:yn,type:ui,colorSpace:t.outputColorSpace,stencilBuffer:m.stencil})}else{let ut=null,Tt=null,mt=null;m.depth&&(mt=m.stencil?e.DEPTH24_STENCIL8:e.DEPTH_COMPONENT24,ut=m.stencil?zs:Ds,Tt=m.stencil?Bs:es);const It={colorFormat:e.RGBA8,depthFormat:mt,scaleFactor:r};h=new XRWebGLBinding(s,e),d=h.createProjectionLayer(It),s.updateRenderState({layers:[d]}),t.setPixelRatio(1),t.setSize(d.textureWidth,d.textureHeight,!1),w=new ns(d.textureWidth,d.textureHeight,{format:yn,type:ui,depthTexture:new Hd(d.textureWidth,d.textureHeight,Tt,void 0,void 0,void 0,void 0,void 0,void 0,ut),stencilBuffer:m.stencil,colorSpace:t.outputColorSpace,samples:m.antialias?4:0,resolveDepthBuffer:d.ignoreDepthValues===!1})}w.isXRRenderTarget=!0,this.setFoveation(l),u=null,o=await s.requestReferenceSpace(a),ee.setContext(s),ee.start(),i.isPresenting=!0,i.dispatchEvent({type:"sessionstart"})}},this.getEnvironmentBlendMode=function(){if(s!==null)return s.environmentBlendMode},this.getDepthTexture=function(){return v.getDepthTexture()};function Y(it){for(let ut=0;ut<it.removed.length;ut++){const Tt=it.removed[ut],mt=x.indexOf(Tt);mt>=0&&(x[mt]=null,b[mt].disconnect(Tt))}for(let ut=0;ut<it.added.length;ut++){const Tt=it.added[ut];let mt=x.indexOf(Tt);if(mt===-1){for(let Nt=0;Nt<b.length;Nt++)if(Nt>=x.length){x.push(Tt),mt=Nt;break}else if(x[Nt]===null){x[Nt]=Tt,mt=Nt;break}if(mt===-1)break}const It=b[mt];It&&It.connect(Tt)}}const H=new G,q=new G;function z(it,ut,Tt){H.setFromMatrixPosition(ut.matrixWorld),q.setFromMatrixPosition(Tt.matrixWorld);const mt=H.distanceTo(q),It=ut.projectionMatrix.elements,Nt=Tt.projectionMatrix.elements,Yt=It[14]/(It[10]-1),A=It[14]/(It[10]+1),R=(It[9]+1)/It[5],X=(It[9]-1)/It[5],T=(It[8]-1)/It[0],nt=(Nt[8]+1)/Nt[0],Z=Yt*T,st=Yt*nt,tt=mt/(-T+nt),rt=tt*-T;if(ut.matrixWorld.decompose(it.position,it.quaternion,it.scale),it.translateX(rt),it.translateZ(tt),it.matrixWorld.compose(it.position,it.quaternion,it.scale),it.matrixWorldInverse.copy(it.matrixWorld).invert(),It[10]===-1)it.projectionMatrix.copy(ut.projectionMatrix),it.projectionMatrixInverse.copy(ut.projectionMatrixInverse);else{const V=Yt+tt,S=A+tt,_=Z-rt,I=st+(mt-rt),W=R*A/S*V,Q=X*A/S*V;it.projectionMatrix.makePerspective(_,I,W,Q,V,S),it.projectionMatrixInverse.copy(it.projectionMatrix).invert()}}function at(it,ut){ut===null?it.matrixWorld.copy(it.matrix):it.matrixWorld.multiplyMatrices(ut.matrixWorld,it.matrix),it.matrixWorldInverse.copy(it.matrixWorld).invert()}this.updateCamera=function(it){if(s===null)return;let ut=it.near,Tt=it.far;v.texture!==null&&(v.depthNear>0&&(ut=v.depthNear),v.depthFar>0&&(Tt=v.depthFar)),M.near=N.near=D.near=ut,M.far=N.far=D.far=Tt,(L!==M.near||J!==M.far)&&(s.updateRenderState({depthNear:M.near,depthFar:M.far}),L=M.near,J=M.far),D.layers.mask=it.layers.mask|2,N.layers.mask=it.layers.mask|4,M.layers.mask=D.layers.mask|N.layers.mask;const mt=it.parent,It=M.cameras;at(M,mt);for(let Nt=0;Nt<It.length;Nt++)at(It[Nt],mt);It.length===2?z(M,D,N):M.projectionMatrix.copy(D.projectionMatrix),dt(it,M,mt)};function dt(it,ut,Tt){Tt===null?it.matrix.copy(ut.matrixWorld):(it.matrix.copy(Tt.matrixWorld),it.matrix.invert(),it.matrix.multiply(ut.matrixWorld)),it.matrix.decompose(it.position,it.quaternion,it.scale),it.updateMatrixWorld(!0),it.projectionMatrix.copy(ut.projectionMatrix),it.projectionMatrixInverse.copy(ut.projectionMatrixInverse),it.isPerspectiveCamera&&(it.fov=ec*2*Math.atan(1/it.projectionMatrix.elements[5]),it.zoom=1)}this.getCamera=function(){return M},this.getFoveation=function(){if(!(d===null&&p===null))return l},this.setFoveation=function(it){l=it,d!==null&&(d.fixedFoveation=it),p!==null&&p.fixedFoveation!==void 0&&(p.fixedFoveation=it)},this.hasDepthSensing=function(){return v.texture!==null},this.getDepthSensingMesh=function(){return v.getMesh(M)};let bt=null;function Ut(it,ut){if(c=ut.getViewerPose(u||o),g=ut,c!==null){const Tt=c.views;p!==null&&(t.setRenderTargetFramebuffer(w,p.framebuffer),t.setRenderTarget(w));let mt=!1;Tt.length!==M.cameras.length&&(M.cameras.length=0,mt=!0);for(let Nt=0;Nt<Tt.length;Nt++){const Yt=Tt[Nt];let A=null;if(p!==null)A=p.getViewport(Yt);else{const X=h.getViewSubImage(d,Yt);A=X.viewport,Nt===0&&(t.setRenderTargetTextures(w,X.colorTexture,d.ignoreDepthValues?void 0:X.depthStencilTexture),t.setRenderTarget(w))}let R=E[Nt];R===void 0&&(R=new on,R.layers.enable(Nt),R.viewport=new ge,E[Nt]=R),R.matrix.fromArray(Yt.transform.matrix),R.matrix.decompose(R.position,R.quaternion,R.scale),R.projectionMatrix.fromArray(Yt.projectionMatrix),R.projectionMatrixInverse.copy(R.projectionMatrix).invert(),R.viewport.set(A.x,A.y,A.width,A.height),Nt===0&&(M.matrix.copy(R.matrix),M.matrix.decompose(M.position,M.quaternion,M.scale)),mt===!0&&M.cameras.push(R)}const It=s.enabledFeatures;if(It&&It.includes("depth-sensing")){const Nt=h.getDepthInformation(Tt[0]);Nt&&Nt.isValid&&Nt.texture&&v.init(t,Nt,s.renderState)}}for(let Tt=0;Tt<b.length;Tt++){const mt=x[Tt],It=b[Tt];mt!==null&&It!==void 0&&It.update(mt,ut,u||o)}bt&&bt(it,ut),ut.detectedPlanes&&i.dispatchEvent({type:"planesdetected",data:ut}),g=null}const ee=new zd;ee.setAnimationLoop(Ut),this.setAnimationLoop=function(it){bt=it},this.dispose=function(){}}}const Vi=new Gn,FM=new ue;function BM(n,t){function e(m,f){m.matrixAutoUpdate===!0&&m.updateMatrix(),f.value.copy(m.matrix)}function i(m,f){f.color.getRGB(m.fogColor.value,Od(n)),f.isFog?(m.fogNear.value=f.near,m.fogFar.value=f.far):f.isFogExp2&&(m.fogDensity.value=f.density)}function s(m,f,w,b,x){f.isMeshBasicMaterial||f.isMeshLambertMaterial?r(m,f):f.isMeshToonMaterial?(r(m,f),h(m,f)):f.isMeshPhongMaterial?(r(m,f),c(m,f)):f.isMeshStandardMaterial?(r(m,f),d(m,f),f.isMeshPhysicalMaterial&&p(m,f,x)):f.isMeshMatcapMaterial?(r(m,f),g(m,f)):f.isMeshDepthMaterial?r(m,f):f.isMeshDistanceMaterial?(r(m,f),v(m,f)):f.isMeshNormalMaterial?r(m,f):f.isLineBasicMaterial?(o(m,f),f.isLineDashedMaterial&&a(m,f)):f.isPointsMaterial?l(m,f,w,b):f.isSpriteMaterial?u(m,f):f.isShadowMaterial?(m.color.value.copy(f.color),m.opacity.value=f.opacity):f.isShaderMaterial&&(f.uniformsNeedUpdate=!1)}function r(m,f){m.opacity.value=f.opacity,f.color&&m.diffuse.value.copy(f.color),f.emissive&&m.emissive.value.copy(f.emissive).multiplyScalar(f.emissiveIntensity),f.map&&(m.map.value=f.map,e(f.map,m.mapTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,e(f.alphaMap,m.alphaMapTransform)),f.bumpMap&&(m.bumpMap.value=f.bumpMap,e(f.bumpMap,m.bumpMapTransform),m.bumpScale.value=f.bumpScale,f.side===Ye&&(m.bumpScale.value*=-1)),f.normalMap&&(m.normalMap.value=f.normalMap,e(f.normalMap,m.normalMapTransform),m.normalScale.value.copy(f.normalScale),f.side===Ye&&m.normalScale.value.negate()),f.displacementMap&&(m.displacementMap.value=f.displacementMap,e(f.displacementMap,m.displacementMapTransform),m.displacementScale.value=f.displacementScale,m.displacementBias.value=f.displacementBias),f.emissiveMap&&(m.emissiveMap.value=f.emissiveMap,e(f.emissiveMap,m.emissiveMapTransform)),f.specularMap&&(m.specularMap.value=f.specularMap,e(f.specularMap,m.specularMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest);const w=t.get(f),b=w.envMap,x=w.envMapRotation;b&&(m.envMap.value=b,Vi.copy(x),Vi.x*=-1,Vi.y*=-1,Vi.z*=-1,b.isCubeTexture&&b.isRenderTargetTexture===!1&&(Vi.y*=-1,Vi.z*=-1),m.envMapRotation.value.setFromMatrix4(FM.makeRotationFromEuler(Vi)),m.flipEnvMap.value=b.isCubeTexture&&b.isRenderTargetTexture===!1?-1:1,m.reflectivity.value=f.reflectivity,m.ior.value=f.ior,m.refractionRatio.value=f.refractionRatio),f.lightMap&&(m.lightMap.value=f.lightMap,m.lightMapIntensity.value=f.lightMapIntensity,e(f.lightMap,m.lightMapTransform)),f.aoMap&&(m.aoMap.value=f.aoMap,m.aoMapIntensity.value=f.aoMapIntensity,e(f.aoMap,m.aoMapTransform))}function o(m,f){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,f.map&&(m.map.value=f.map,e(f.map,m.mapTransform))}function a(m,f){m.dashSize.value=f.dashSize,m.totalSize.value=f.dashSize+f.gapSize,m.scale.value=f.scale}function l(m,f,w,b){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,m.size.value=f.size*w,m.scale.value=b*.5,f.map&&(m.map.value=f.map,e(f.map,m.uvTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,e(f.alphaMap,m.alphaMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest)}function u(m,f){m.diffuse.value.copy(f.color),m.opacity.value=f.opacity,m.rotation.value=f.rotation,f.map&&(m.map.value=f.map,e(f.map,m.mapTransform)),f.alphaMap&&(m.alphaMap.value=f.alphaMap,e(f.alphaMap,m.alphaMapTransform)),f.alphaTest>0&&(m.alphaTest.value=f.alphaTest)}function c(m,f){m.specular.value.copy(f.specular),m.shininess.value=Math.max(f.shininess,1e-4)}function h(m,f){f.gradientMap&&(m.gradientMap.value=f.gradientMap)}function d(m,f){m.metalness.value=f.metalness,f.metalnessMap&&(m.metalnessMap.value=f.metalnessMap,e(f.metalnessMap,m.metalnessMapTransform)),m.roughness.value=f.roughness,f.roughnessMap&&(m.roughnessMap.value=f.roughnessMap,e(f.roughnessMap,m.roughnessMapTransform)),f.envMap&&(m.envMapIntensity.value=f.envMapIntensity)}function p(m,f,w){m.ior.value=f.ior,f.sheen>0&&(m.sheenColor.value.copy(f.sheenColor).multiplyScalar(f.sheen),m.sheenRoughness.value=f.sheenRoughness,f.sheenColorMap&&(m.sheenColorMap.value=f.sheenColorMap,e(f.sheenColorMap,m.sheenColorMapTransform)),f.sheenRoughnessMap&&(m.sheenRoughnessMap.value=f.sheenRoughnessMap,e(f.sheenRoughnessMap,m.sheenRoughnessMapTransform))),f.clearcoat>0&&(m.clearcoat.value=f.clearcoat,m.clearcoatRoughness.value=f.clearcoatRoughness,f.clearcoatMap&&(m.clearcoatMap.value=f.clearcoatMap,e(f.clearcoatMap,m.clearcoatMapTransform)),f.clearcoatRoughnessMap&&(m.clearcoatRoughnessMap.value=f.clearcoatRoughnessMap,e(f.clearcoatRoughnessMap,m.clearcoatRoughnessMapTransform)),f.clearcoatNormalMap&&(m.clearcoatNormalMap.value=f.clearcoatNormalMap,e(f.clearcoatNormalMap,m.clearcoatNormalMapTransform),m.clearcoatNormalScale.value.copy(f.clearcoatNormalScale),f.side===Ye&&m.clearcoatNormalScale.value.negate())),f.dispersion>0&&(m.dispersion.value=f.dispersion),f.iridescence>0&&(m.iridescence.value=f.iridescence,m.iridescenceIOR.value=f.iridescenceIOR,m.iridescenceThicknessMinimum.value=f.iridescenceThicknessRange[0],m.iridescenceThicknessMaximum.value=f.iridescenceThicknessRange[1],f.iridescenceMap&&(m.iridescenceMap.value=f.iridescenceMap,e(f.iridescenceMap,m.iridescenceMapTransform)),f.iridescenceThicknessMap&&(m.iridescenceThicknessMap.value=f.iridescenceThicknessMap,e(f.iridescenceThicknessMap,m.iridescenceThicknessMapTransform))),f.transmission>0&&(m.transmission.value=f.transmission,m.transmissionSamplerMap.value=w.texture,m.transmissionSamplerSize.value.set(w.width,w.height),f.transmissionMap&&(m.transmissionMap.value=f.transmissionMap,e(f.transmissionMap,m.transmissionMapTransform)),m.thickness.value=f.thickness,f.thicknessMap&&(m.thicknessMap.value=f.thicknessMap,e(f.thicknessMap,m.thicknessMapTransform)),m.attenuationDistance.value=f.attenuationDistance,m.attenuationColor.value.copy(f.attenuationColor)),f.anisotropy>0&&(m.anisotropyVector.value.set(f.anisotropy*Math.cos(f.anisotropyRotation),f.anisotropy*Math.sin(f.anisotropyRotation)),f.anisotropyMap&&(m.anisotropyMap.value=f.anisotropyMap,e(f.anisotropyMap,m.anisotropyMapTransform))),m.specularIntensity.value=f.specularIntensity,m.specularColor.value.copy(f.specularColor),f.specularColorMap&&(m.specularColorMap.value=f.specularColorMap,e(f.specularColorMap,m.specularColorMapTransform)),f.specularIntensityMap&&(m.specularIntensityMap.value=f.specularIntensityMap,e(f.specularIntensityMap,m.specularIntensityMapTransform))}function g(m,f){f.matcap&&(m.matcap.value=f.matcap)}function v(m,f){const w=t.get(f).light;m.referencePosition.value.setFromMatrixPosition(w.matrixWorld),m.nearDistance.value=w.shadow.camera.near,m.farDistance.value=w.shadow.camera.far}return{refreshFogUniforms:i,refreshMaterialUniforms:s}}function zM(n,t,e,i){let s={},r={},o=[];const a=n.getParameter(n.MAX_UNIFORM_BUFFER_BINDINGS);function l(w,b){const x=b.program;i.uniformBlockBinding(w,x)}function u(w,b){let x=s[w.id];x===void 0&&(g(w),x=c(w),s[w.id]=x,w.addEventListener("dispose",m));const B=b.program;i.updateUBOMapping(w,B);const P=t.render.frame;r[w.id]!==P&&(d(w),r[w.id]=P)}function c(w){const b=h();w.__bindingPointIndex=b;const x=n.createBuffer(),B=w.__size,P=w.usage;return n.bindBuffer(n.UNIFORM_BUFFER,x),n.bufferData(n.UNIFORM_BUFFER,B,P),n.bindBuffer(n.UNIFORM_BUFFER,null),n.bindBufferBase(n.UNIFORM_BUFFER,b,x),x}function h(){for(let w=0;w<a;w++)if(o.indexOf(w)===-1)return o.push(w),w;return console.error("THREE.WebGLRenderer: Maximum number of simultaneously usable uniforms groups reached."),0}function d(w){const b=s[w.id],x=w.uniforms,B=w.__cache;n.bindBuffer(n.UNIFORM_BUFFER,b);for(let P=0,D=x.length;P<D;P++){const N=Array.isArray(x[P])?x[P]:[x[P]];for(let E=0,M=N.length;E<M;E++){const L=N[E];if(p(L,P,E,B)===!0){const J=L.__offset,C=Array.isArray(L.value)?L.value:[L.value];let k=0;for(let Y=0;Y<C.length;Y++){const H=C[Y],q=v(H);typeof H=="number"||typeof H=="boolean"?(L.__data[0]=H,n.bufferSubData(n.UNIFORM_BUFFER,J+k,L.__data)):H.isMatrix3?(L.__data[0]=H.elements[0],L.__data[1]=H.elements[1],L.__data[2]=H.elements[2],L.__data[3]=0,L.__data[4]=H.elements[3],L.__data[5]=H.elements[4],L.__data[6]=H.elements[5],L.__data[7]=0,L.__data[8]=H.elements[6],L.__data[9]=H.elements[7],L.__data[10]=H.elements[8],L.__data[11]=0):(H.toArray(L.__data,k),k+=q.storage/Float32Array.BYTES_PER_ELEMENT)}n.bufferSubData(n.UNIFORM_BUFFER,J,L.__data)}}}n.bindBuffer(n.UNIFORM_BUFFER,null)}function p(w,b,x,B){const P=w.value,D=b+"_"+x;if(B[D]===void 0)return typeof P=="number"||typeof P=="boolean"?B[D]=P:B[D]=P.clone(),!0;{const N=B[D];if(typeof P=="number"||typeof P=="boolean"){if(N!==P)return B[D]=P,!0}else if(N.equals(P)===!1)return N.copy(P),!0}return!1}function g(w){const b=w.uniforms;let x=0;const B=16;for(let D=0,N=b.length;D<N;D++){const E=Array.isArray(b[D])?b[D]:[b[D]];for(let M=0,L=E.length;M<L;M++){const J=E[M],C=Array.isArray(J.value)?J.value:[J.value];for(let k=0,Y=C.length;k<Y;k++){const H=C[k],q=v(H),z=x%B,at=z%q.boundary,dt=z+at;x+=at,dt!==0&&B-dt<q.storage&&(x+=B-dt),J.__data=new Float32Array(q.storage/Float32Array.BYTES_PER_ELEMENT),J.__offset=x,x+=q.storage}}}const P=x%B;return P>0&&(x+=B-P),w.__size=x,w.__cache={},this}function v(w){const b={boundary:0,storage:0};return typeof w=="number"||typeof w=="boolean"?(b.boundary=4,b.storage=4):w.isVector2?(b.boundary=8,b.storage=8):w.isVector3||w.isColor?(b.boundary=16,b.storage=12):w.isVector4?(b.boundary=16,b.storage=16):w.isMatrix3?(b.boundary=48,b.storage=48):w.isMatrix4?(b.boundary=64,b.storage=64):w.isTexture?console.warn("THREE.WebGLRenderer: Texture samplers can not be part of an uniforms group."):console.warn("THREE.WebGLRenderer: Unsupported uniform value type.",w),b}function m(w){const b=w.target;b.removeEventListener("dispose",m);const x=o.indexOf(b.__bindingPointIndex);o.splice(x,1),n.deleteBuffer(s[b.id]),delete s[b.id],delete r[b.id]}function f(){for(const w in s)n.deleteBuffer(s[w]);o=[],s={},r={}}return{bind:l,update:u,dispose:f}}class ko{constructor(t={}){const{canvas:e=Rg(),context:i=null,depth:s=!0,stencil:r=!1,alpha:o=!1,antialias:a=!1,premultipliedAlpha:l=!0,preserveDrawingBuffer:u=!1,powerPreference:c="default",failIfMajorPerformanceCaveat:h=!1,reverseDepthBuffer:d=!1}=t;this.isWebGLRenderer=!0;let p;if(i!==null){if(typeof WebGLRenderingContext<"u"&&i instanceof WebGLRenderingContext)throw new Error("THREE.WebGLRenderer: WebGL 1 is not supported since r163.");p=i.getContextAttributes().alpha}else p=o;const g=new Uint32Array(4),v=new Int32Array(4);let m=null,f=null;const w=[],b=[];this.domElement=e,this.debug={checkShaderErrors:!0,onShaderError:null},this.autoClear=!0,this.autoClearColor=!0,this.autoClearDepth=!0,this.autoClearStencil=!0,this.sortObjects=!0,this.clippingPlanes=[],this.localClippingEnabled=!1,this._outputColorSpace=rn,this.toneMapping=Ri,this.toneMappingExposure=1;const x=this;let B=!1,P=0,D=0,N=null,E=-1,M=null;const L=new ge,J=new ge;let C=null;const k=new $t(0);let Y=0,H=e.width,q=e.height,z=1,at=null,dt=null;const bt=new ge(0,0,H,q),Ut=new ge(0,0,H,q);let ee=!1;const it=new Fc;let ut=!1,Tt=!1;const mt=new ue,It=new ue,Nt=new G,Yt=new ge,A={background:null,fog:null,environment:null,overrideMaterial:null,isScene:!0};let R=!1;function X(){return N===null?z:1}let T=i;function nt(y,O){return e.getContext(y,O)}try{const y={alpha:!0,depth:s,stencil:r,antialias:a,premultipliedAlpha:l,preserveDrawingBuffer:u,powerPreference:c,failIfMajorPerformanceCaveat:h};if("setAttribute"in e&&e.setAttribute("data-engine",`three.js r${ea}`),e.addEventListener("webglcontextlost",ot,!1),e.addEventListener("webglcontextrestored",Et,!1),e.addEventListener("webglcontextcreationerror",yt,!1),T===null){const O="webgl2";if(T=nt(O,y),T===null)throw nt(O)?new Error("Error creating WebGL context with your selected attributes."):new Error("Error creating WebGL context.")}}catch(y){throw console.error("THREE.WebGLRenderer: "+y.message),y}let Z,st,tt,rt,V,S,_,I,W,Q,$,ht,ct,pt,Ft,lt,St,Lt,At,gt,Kt,zt,he,U;function vt(){Z=new Xx(T),Z.init(),zt=new PM(T,Z),st=new zx(T,Z,t,zt),tt=new wM(T,Z),st.reverseDepthBuffer&&d&&tt.buffers.depth.setReversed(!0),rt=new jx(T),V=new fM,S=new CM(T,Z,tt,V,st,zt,rt),_=new Hx(x),I=new Wx(x),W=new ev(T),he=new Fx(T,W),Q=new qx(T,W,rt,he),$=new $x(T,Q,W,rt),At=new Kx(T,st,S),lt=new kx(V),ht=new hM(x,_,I,Z,st,he,lt),ct=new BM(x,V),pt=new pM,Ft=new yM(Z),Lt=new Ox(x,_,I,tt,$,p,l),St=new TM(x,$,st),U=new zM(T,rt,st,tt),gt=new Bx(T,Z,rt),Kt=new Yx(T,Z,rt),rt.programs=ht.programs,x.capabilities=st,x.extensions=Z,x.properties=V,x.renderLists=pt,x.shadowMap=St,x.state=tt,x.info=rt}vt();const et=new OM(x,T);this.xr=et,this.getContext=function(){return T},this.getContextAttributes=function(){return T.getContextAttributes()},this.forceContextLoss=function(){const y=Z.get("WEBGL_lose_context");y&&y.loseContext()},this.forceContextRestore=function(){const y=Z.get("WEBGL_lose_context");y&&y.restoreContext()},this.getPixelRatio=function(){return z},this.setPixelRatio=function(y){y!==void 0&&(z=y,this.setSize(H,q,!1))},this.getSize=function(y){return y.set(H,q)},this.setSize=function(y,O,j=!0){if(et.isPresenting){console.warn("THREE.WebGLRenderer: Can't change size while VR device is presenting.");return}H=y,q=O,e.width=Math.floor(y*z),e.height=Math.floor(O*z),j===!0&&(e.style.width=y+"px",e.style.height=O+"px"),this.setViewport(0,0,y,O)},this.getDrawingBufferSize=function(y){return y.set(H*z,q*z).floor()},this.setDrawingBufferSize=function(y,O,j){H=y,q=O,z=j,e.width=Math.floor(y*j),e.height=Math.floor(O*j),this.setViewport(0,0,y,O)},this.getCurrentViewport=function(y){return y.copy(L)},this.getViewport=function(y){return y.copy(bt)},this.setViewport=function(y,O,j,K){y.isVector4?bt.set(y.x,y.y,y.z,y.w):bt.set(y,O,j,K),tt.viewport(L.copy(bt).multiplyScalar(z).round())},this.getScissor=function(y){return y.copy(Ut)},this.setScissor=function(y,O,j,K){y.isVector4?Ut.set(y.x,y.y,y.z,y.w):Ut.set(y,O,j,K),tt.scissor(J.copy(Ut).multiplyScalar(z).round())},this.getScissorTest=function(){return ee},this.setScissorTest=function(y){tt.setScissorTest(ee=y)},this.setOpaqueSort=function(y){at=y},this.setTransparentSort=function(y){dt=y},this.getClearColor=function(y){return y.copy(Lt.getClearColor())},this.setClearColor=function(){Lt.setClearColor.apply(Lt,arguments)},this.getClearAlpha=function(){return Lt.getClearAlpha()},this.setClearAlpha=function(){Lt.setClearAlpha.apply(Lt,arguments)},this.clear=function(y=!0,O=!0,j=!0){let K=0;if(y){let F=!1;if(N!==null){const ft=N.texture.format;F=ft===Oc||ft===Nc||ft===Uc}if(F){const ft=N.texture.type,Mt=ft===ui||ft===es||ft===br||ft===Bs||ft===Dc||ft===Lc,wt=Lt.getClearColor(),Rt=Lt.getClearAlpha(),Bt=wt.r,Gt=wt.g,Ct=wt.b;Mt?(g[0]=Bt,g[1]=Gt,g[2]=Ct,g[3]=Rt,T.clearBufferuiv(T.COLOR,0,g)):(v[0]=Bt,v[1]=Gt,v[2]=Ct,v[3]=Rt,T.clearBufferiv(T.COLOR,0,v))}else K|=T.COLOR_BUFFER_BIT}O&&(K|=T.DEPTH_BUFFER_BIT),j&&(K|=T.STENCIL_BUFFER_BIT,this.state.buffers.stencil.setMask(4294967295)),T.clear(K)},this.clearColor=function(){this.clear(!0,!1,!1)},this.clearDepth=function(){this.clear(!1,!0,!1)},this.clearStencil=function(){this.clear(!1,!1,!0)},this.dispose=function(){e.removeEventListener("webglcontextlost",ot,!1),e.removeEventListener("webglcontextrestored",Et,!1),e.removeEventListener("webglcontextcreationerror",yt,!1),pt.dispose(),Ft.dispose(),V.dispose(),_.dispose(),I.dispose(),$.dispose(),he.dispose(),U.dispose(),ht.dispose(),et.dispose(),et.removeEventListener("sessionstart",$c),et.removeEventListener("sessionend",Zc),Ii.stop()};function ot(y){y.preventDefault(),console.log("THREE.WebGLRenderer: Context Lost."),B=!0}function Et(){console.log("THREE.WebGLRenderer: Context Restored."),B=!1;const y=rt.autoReset,O=St.enabled,j=St.autoUpdate,K=St.needsUpdate,F=St.type;vt(),rt.autoReset=y,St.enabled=O,St.autoUpdate=j,St.needsUpdate=K,St.type=F}function yt(y){console.error("THREE.WebGLRenderer: A WebGL context could not be created. Reason: ",y.statusMessage)}function Vt(y){const O=y.target;O.removeEventListener("dispose",Vt),_e(O)}function _e(y){Re(y),V.remove(y)}function Re(y){const O=V.get(y).programs;O!==void 0&&(O.forEach(function(j){ht.releaseProgram(j)}),y.isShaderMaterial&&ht.releaseShaderCache(y))}this.renderBufferDirect=function(y,O,j,K,F,ft){O===null&&(O=A);const Mt=F.isMesh&&F.matrixWorld.determinant()<0,wt=fp(y,O,j,K,F);tt.setMaterial(K,Mt);let Rt=j.index,Bt=1;if(K.wireframe===!0){if(Rt=Q.getWireframeAttribute(j),Rt===void 0)return;Bt=2}const Gt=j.drawRange,Ct=j.attributes.position;let Qt=Gt.start*Bt,fe=(Gt.start+Gt.count)*Bt;ft!==null&&(Qt=Math.max(Qt,ft.start*Bt),fe=Math.min(fe,(ft.start+ft.count)*Bt)),Rt!==null?(Qt=Math.max(Qt,0),fe=Math.min(fe,Rt.count)):Ct!=null&&(Qt=Math.max(Qt,0),fe=Math.min(fe,Ct.count));const pe=fe-Qt;if(pe<0||pe===1/0)return;he.setup(F,K,wt,j,Rt);let ke,ne=gt;if(Rt!==null&&(ke=W.get(Rt),ne=Kt,ne.setIndex(ke)),F.isMesh)K.wireframe===!0?(tt.setLineWidth(K.wireframeLinewidth*X()),ne.setMode(T.LINES)):ne.setMode(T.TRIANGLES);else if(F.isLine){let Pt=K.linewidth;Pt===void 0&&(Pt=1),tt.setLineWidth(Pt*X()),F.isLineSegments?ne.setMode(T.LINES):F.isLineLoop?ne.setMode(T.LINE_LOOP):ne.setMode(T.LINE_STRIP)}else F.isPoints?ne.setMode(T.POINTS):F.isSprite&&ne.setMode(T.TRIANGLES);if(F.isBatchedMesh)if(F._multiDrawInstances!==null)ne.renderMultiDrawInstances(F._multiDrawStarts,F._multiDrawCounts,F._multiDrawCount,F._multiDrawInstances);else if(Z.get("WEBGL_multi_draw"))ne.renderMultiDraw(F._multiDrawStarts,F._multiDrawCounts,F._multiDrawCount);else{const Pt=F._multiDrawStarts,jn=F._multiDrawCounts,ie=F._multiDrawCount,fn=Rt?W.get(Rt).bytesPerElement:1,as=V.get(K).currentProgram.getUniforms();for(let je=0;je<ie;je++)as.setValue(T,"_gl_DrawID",je),ne.render(Pt[je]/fn,jn[je])}else if(F.isInstancedMesh)ne.renderInstances(Qt,pe,F.count);else if(j.isInstancedBufferGeometry){const Pt=j._maxInstanceCount!==void 0?j._maxInstanceCount:1/0,jn=Math.min(j.instanceCount,Pt);ne.renderInstances(Qt,pe,jn)}else ne.render(Qt,pe)};function re(y,O,j){y.transparent===!0&&y.side===In&&y.forceSinglePass===!1?(y.side=Ye,y.needsUpdate=!0,Ur(y,O,j),y.side=Pi,y.needsUpdate=!0,Ur(y,O,j),y.side=In):Ur(y,O,j)}this.compile=function(y,O,j=null){j===null&&(j=y),f=Ft.get(j),f.init(O),b.push(f),j.traverseVisible(function(F){F.isLight&&F.layers.test(O.layers)&&(f.pushLight(F),F.castShadow&&f.pushShadow(F))}),y!==j&&y.traverseVisible(function(F){F.isLight&&F.layers.test(O.layers)&&(f.pushLight(F),F.castShadow&&f.pushShadow(F))}),f.setupLights();const K=new Set;return y.traverse(function(F){if(!(F.isMesh||F.isPoints||F.isLine||F.isSprite))return;const ft=F.material;if(ft)if(Array.isArray(ft))for(let Mt=0;Mt<ft.length;Mt++){const wt=ft[Mt];re(wt,j,F),K.add(wt)}else re(ft,j,F),K.add(ft)}),b.pop(),f=null,K},this.compileAsync=function(y,O,j=null){const K=this.compile(y,O,j);return new Promise(F=>{function ft(){if(K.forEach(function(Mt){V.get(Mt).currentProgram.isReady()&&K.delete(Mt)}),K.size===0){F(y);return}setTimeout(ft,10)}Z.get("KHR_parallel_shader_compile")!==null?ft():setTimeout(ft,10)})};let hn=null;function Yn(y){hn&&hn(y)}function $c(){Ii.stop()}function Zc(){Ii.start()}const Ii=new zd;Ii.setAnimationLoop(Yn),typeof self<"u"&&Ii.setContext(self),this.setAnimationLoop=function(y){hn=y,et.setAnimationLoop(y),y===null?Ii.stop():Ii.start()},et.addEventListener("sessionstart",$c),et.addEventListener("sessionend",Zc),this.render=function(y,O){if(O!==void 0&&O.isCamera!==!0){console.error("THREE.WebGLRenderer.render: camera is not an instance of THREE.Camera.");return}if(B===!0)return;if(y.matrixWorldAutoUpdate===!0&&y.updateMatrixWorld(),O.parent===null&&O.matrixWorldAutoUpdate===!0&&O.updateMatrixWorld(),et.enabled===!0&&et.isPresenting===!0&&(et.cameraAutoUpdate===!0&&et.updateCamera(O),O=et.getCamera()),y.isScene===!0&&y.onBeforeRender(x,y,O,N),f=Ft.get(y,b.length),f.init(O),b.push(f),It.multiplyMatrices(O.projectionMatrix,O.matrixWorldInverse),it.setFromProjectionMatrix(It),Tt=this.localClippingEnabled,ut=lt.init(this.clippingPlanes,Tt),m=pt.get(y,w.length),m.init(),w.push(m),et.enabled===!0&&et.isPresenting===!0){const ft=x.xr.getDepthSensingMesh();ft!==null&&la(ft,O,-1/0,x.sortObjects)}la(y,O,0,x.sortObjects),m.finish(),x.sortObjects===!0&&m.sort(at,dt),R=et.enabled===!1||et.isPresenting===!1||et.hasDepthSensing()===!1,R&&Lt.addToRenderList(m,y),this.info.render.frame++,ut===!0&&lt.beginShadows();const j=f.state.shadowsArray;St.render(j,y,O),ut===!0&&lt.endShadows(),this.info.autoReset===!0&&this.info.reset();const K=m.opaque,F=m.transmissive;if(f.setupLights(),O.isArrayCamera){const ft=O.cameras;if(F.length>0)for(let Mt=0,wt=ft.length;Mt<wt;Mt++){const Rt=ft[Mt];Qc(K,F,y,Rt)}R&&Lt.render(y);for(let Mt=0,wt=ft.length;Mt<wt;Mt++){const Rt=ft[Mt];Jc(m,y,Rt,Rt.viewport)}}else F.length>0&&Qc(K,F,y,O),R&&Lt.render(y),Jc(m,y,O);N!==null&&(S.updateMultisampleRenderTarget(N),S.updateRenderTargetMipmap(N)),y.isScene===!0&&y.onAfterRender(x,y,O),he.resetDefaultState(),E=-1,M=null,b.pop(),b.length>0?(f=b[b.length-1],ut===!0&&lt.setGlobalState(x.clippingPlanes,f.state.camera)):f=null,w.pop(),w.length>0?m=w[w.length-1]:m=null};function la(y,O,j,K){if(y.visible===!1)return;if(y.layers.test(O.layers)){if(y.isGroup)j=y.renderOrder;else if(y.isLOD)y.autoUpdate===!0&&y.update(O);else if(y.isLight)f.pushLight(y),y.castShadow&&f.pushShadow(y);else if(y.isSprite){if(!y.frustumCulled||it.intersectsSprite(y)){K&&Yt.setFromMatrixPosition(y.matrixWorld).applyMatrix4(It);const Mt=$.update(y),wt=y.material;wt.visible&&m.push(y,Mt,wt,j,Yt.z,null)}}else if((y.isMesh||y.isLine||y.isPoints)&&(!y.frustumCulled||it.intersectsObject(y))){const Mt=$.update(y),wt=y.material;if(K&&(y.boundingSphere!==void 0?(y.boundingSphere===null&&y.computeBoundingSphere(),Yt.copy(y.boundingSphere.center)):(Mt.boundingSphere===null&&Mt.computeBoundingSphere(),Yt.copy(Mt.boundingSphere.center)),Yt.applyMatrix4(y.matrixWorld).applyMatrix4(It)),Array.isArray(wt)){const Rt=Mt.groups;for(let Bt=0,Gt=Rt.length;Bt<Gt;Bt++){const Ct=Rt[Bt],Qt=wt[Ct.materialIndex];Qt&&Qt.visible&&m.push(y,Mt,Qt,j,Yt.z,Ct)}}else wt.visible&&m.push(y,Mt,wt,j,Yt.z,null)}}const ft=y.children;for(let Mt=0,wt=ft.length;Mt<wt;Mt++)la(ft[Mt],O,j,K)}function Jc(y,O,j,K){const F=y.opaque,ft=y.transmissive,Mt=y.transparent;f.setupLightsView(j),ut===!0&&lt.setGlobalState(x.clippingPlanes,j),K&&tt.viewport(L.copy(K)),F.length>0&&Ir(F,O,j),ft.length>0&&Ir(ft,O,j),Mt.length>0&&Ir(Mt,O,j),tt.buffers.depth.setTest(!0),tt.buffers.depth.setMask(!0),tt.buffers.color.setMask(!0),tt.setPolygonOffset(!1)}function Qc(y,O,j,K){if((j.isScene===!0?j.overrideMaterial:null)!==null)return;f.state.transmissionRenderTarget[K.id]===void 0&&(f.state.transmissionRenderTarget[K.id]=new ns(1,1,{generateMipmaps:!0,type:Z.has("EXT_color_buffer_half_float")||Z.has("EXT_color_buffer_float")?Cr:ui,minFilter:Zi,samples:4,stencilBuffer:r,resolveDepthBuffer:!1,resolveStencilBuffer:!1,colorSpace:Jt.workingColorSpace}));const ft=f.state.transmissionRenderTarget[K.id],Mt=K.viewport||L;ft.setSize(Mt.z,Mt.w);const wt=x.getRenderTarget();x.setRenderTarget(ft),x.getClearColor(k),Y=x.getClearAlpha(),Y<1&&x.setClearColor(16777215,.5),x.clear(),R&&Lt.render(j);const Rt=x.toneMapping;x.toneMapping=Ri;const Bt=K.viewport;if(K.viewport!==void 0&&(K.viewport=void 0),f.setupLightsView(K),ut===!0&&lt.setGlobalState(x.clippingPlanes,K),Ir(y,j,K),S.updateMultisampleRenderTarget(ft),S.updateRenderTargetMipmap(ft),Z.has("WEBGL_multisampled_render_to_texture")===!1){let Gt=!1;for(let Ct=0,Qt=O.length;Ct<Qt;Ct++){const fe=O[Ct],pe=fe.object,ke=fe.geometry,ne=fe.material,Pt=fe.group;if(ne.side===In&&pe.layers.test(K.layers)){const jn=ne.side;ne.side=Ye,ne.needsUpdate=!0,tu(pe,j,K,ke,ne,Pt),ne.side=jn,ne.needsUpdate=!0,Gt=!0}}Gt===!0&&(S.updateMultisampleRenderTarget(ft),S.updateRenderTargetMipmap(ft))}x.setRenderTarget(wt),x.setClearColor(k,Y),Bt!==void 0&&(K.viewport=Bt),x.toneMapping=Rt}function Ir(y,O,j){const K=O.isScene===!0?O.overrideMaterial:null;for(let F=0,ft=y.length;F<ft;F++){const Mt=y[F],wt=Mt.object,Rt=Mt.geometry,Bt=K===null?Mt.material:K,Gt=Mt.group;wt.layers.test(j.layers)&&tu(wt,O,j,Rt,Bt,Gt)}}function tu(y,O,j,K,F,ft){y.onBeforeRender(x,O,j,K,F,ft),y.modelViewMatrix.multiplyMatrices(j.matrixWorldInverse,y.matrixWorld),y.normalMatrix.getNormalMatrix(y.modelViewMatrix),F.onBeforeRender(x,O,j,K,y,ft),F.transparent===!0&&F.side===In&&F.forceSinglePass===!1?(F.side=Ye,F.needsUpdate=!0,x.renderBufferDirect(j,O,K,F,y,ft),F.side=Pi,F.needsUpdate=!0,x.renderBufferDirect(j,O,K,F,y,ft),F.side=In):x.renderBufferDirect(j,O,K,F,y,ft),y.onAfterRender(x,O,j,K,F,ft)}function Ur(y,O,j){O.isScene!==!0&&(O=A);const K=V.get(y),F=f.state.lights,ft=f.state.shadowsArray,Mt=F.state.version,wt=ht.getParameters(y,F.state,ft,O,j),Rt=ht.getProgramCacheKey(wt);let Bt=K.programs;K.environment=y.isMeshStandardMaterial?O.environment:null,K.fog=O.fog,K.envMap=(y.isMeshStandardMaterial?I:_).get(y.envMap||K.environment),K.envMapRotation=K.environment!==null&&y.envMap===null?O.environmentRotation:y.envMapRotation,Bt===void 0&&(y.addEventListener("dispose",Vt),Bt=new Map,K.programs=Bt);let Gt=Bt.get(Rt);if(Gt!==void 0){if(K.currentProgram===Gt&&K.lightsStateVersion===Mt)return nu(y,wt),Gt}else wt.uniforms=ht.getUniforms(y),y.onBeforeCompile(wt,x),Gt=ht.acquireProgram(wt,Rt),Bt.set(Rt,Gt),K.uniforms=wt.uniforms;const Ct=K.uniforms;return(!y.isShaderMaterial&&!y.isRawShaderMaterial||y.clipping===!0)&&(Ct.clippingPlanes=lt.uniform),nu(y,wt),K.needsLights=pp(y),K.lightsStateVersion=Mt,K.needsLights&&(Ct.ambientLightColor.value=F.state.ambient,Ct.lightProbe.value=F.state.probe,Ct.directionalLights.value=F.state.directional,Ct.directionalLightShadows.value=F.state.directionalShadow,Ct.spotLights.value=F.state.spot,Ct.spotLightShadows.value=F.state.spotShadow,Ct.rectAreaLights.value=F.state.rectArea,Ct.ltc_1.value=F.state.rectAreaLTC1,Ct.ltc_2.value=F.state.rectAreaLTC2,Ct.pointLights.value=F.state.point,Ct.pointLightShadows.value=F.state.pointShadow,Ct.hemisphereLights.value=F.state.hemi,Ct.directionalShadowMap.value=F.state.directionalShadowMap,Ct.directionalShadowMatrix.value=F.state.directionalShadowMatrix,Ct.spotShadowMap.value=F.state.spotShadowMap,Ct.spotLightMatrix.value=F.state.spotLightMatrix,Ct.spotLightMap.value=F.state.spotLightMap,Ct.pointShadowMap.value=F.state.pointShadowMap,Ct.pointShadowMatrix.value=F.state.pointShadowMatrix),K.currentProgram=Gt,K.uniformsList=null,Gt}function eu(y){if(y.uniformsList===null){const O=y.currentProgram.getUniforms();y.uniformsList=Eo.seqWithValue(O.seq,y.uniforms)}return y.uniformsList}function nu(y,O){const j=V.get(y);j.outputColorSpace=O.outputColorSpace,j.batching=O.batching,j.batchingColor=O.batchingColor,j.instancing=O.instancing,j.instancingColor=O.instancingColor,j.instancingMorph=O.instancingMorph,j.skinning=O.skinning,j.morphTargets=O.morphTargets,j.morphNormals=O.morphNormals,j.morphColors=O.morphColors,j.morphTargetsCount=O.morphTargetsCount,j.numClippingPlanes=O.numClippingPlanes,j.numIntersection=O.numClipIntersection,j.vertexAlphas=O.vertexAlphas,j.vertexTangents=O.vertexTangents,j.toneMapping=O.toneMapping}function fp(y,O,j,K,F){O.isScene!==!0&&(O=A),S.resetTextureUnits();const ft=O.fog,Mt=K.isMeshStandardMaterial?O.environment:null,wt=N===null?x.outputColorSpace:N.isXRRenderTarget===!0?N.texture.colorSpace:Hs,Rt=(K.isMeshStandardMaterial?I:_).get(K.envMap||Mt),Bt=K.vertexColors===!0&&!!j.attributes.color&&j.attributes.color.itemSize===4,Gt=!!j.attributes.tangent&&(!!K.normalMap||K.anisotropy>0),Ct=!!j.morphAttributes.position,Qt=!!j.morphAttributes.normal,fe=!!j.morphAttributes.color;let pe=Ri;K.toneMapped&&(N===null||N.isXRRenderTarget===!0)&&(pe=x.toneMapping);const ke=j.morphAttributes.position||j.morphAttributes.normal||j.morphAttributes.color,ne=ke!==void 0?ke.length:0,Pt=V.get(K),jn=f.state.lights;if(ut===!0&&(Tt===!0||y!==M)){const Qe=y===M&&K.id===E;lt.setState(K,y,Qe)}let ie=!1;K.version===Pt.__version?(Pt.needsLights&&Pt.lightsStateVersion!==jn.state.version||Pt.outputColorSpace!==wt||F.isBatchedMesh&&Pt.batching===!1||!F.isBatchedMesh&&Pt.batching===!0||F.isBatchedMesh&&Pt.batchingColor===!0&&F.colorTexture===null||F.isBatchedMesh&&Pt.batchingColor===!1&&F.colorTexture!==null||F.isInstancedMesh&&Pt.instancing===!1||!F.isInstancedMesh&&Pt.instancing===!0||F.isSkinnedMesh&&Pt.skinning===!1||!F.isSkinnedMesh&&Pt.skinning===!0||F.isInstancedMesh&&Pt.instancingColor===!0&&F.instanceColor===null||F.isInstancedMesh&&Pt.instancingColor===!1&&F.instanceColor!==null||F.isInstancedMesh&&Pt.instancingMorph===!0&&F.morphTexture===null||F.isInstancedMesh&&Pt.instancingMorph===!1&&F.morphTexture!==null||Pt.envMap!==Rt||K.fog===!0&&Pt.fog!==ft||Pt.numClippingPlanes!==void 0&&(Pt.numClippingPlanes!==lt.numPlanes||Pt.numIntersection!==lt.numIntersection)||Pt.vertexAlphas!==Bt||Pt.vertexTangents!==Gt||Pt.morphTargets!==Ct||Pt.morphNormals!==Qt||Pt.morphColors!==fe||Pt.toneMapping!==pe||Pt.morphTargetsCount!==ne)&&(ie=!0):(ie=!0,Pt.__version=K.version);let fn=Pt.currentProgram;ie===!0&&(fn=Ur(K,O,F));let as=!1,je=!1,Ws=!1;const me=fn.getUniforms(),An=Pt.uniforms;if(tt.useProgram(fn.program)&&(as=!0,je=!0,Ws=!0),K.id!==E&&(E=K.id,je=!0),as||M!==y){tt.buffers.depth.getReversed()?(mt.copy(y.projectionMatrix),Pg(mt),Dg(mt),me.setValue(T,"projectionMatrix",mt)):me.setValue(T,"projectionMatrix",y.projectionMatrix),me.setValue(T,"viewMatrix",y.matrixWorldInverse);const fi=me.map.cameraPosition;fi!==void 0&&fi.setValue(T,Nt.setFromMatrixPosition(y.matrixWorld)),st.logarithmicDepthBuffer&&me.setValue(T,"logDepthBufFC",2/(Math.log(y.far+1)/Math.LN2)),(K.isMeshPhongMaterial||K.isMeshToonMaterial||K.isMeshLambertMaterial||K.isMeshBasicMaterial||K.isMeshStandardMaterial||K.isShaderMaterial)&&me.setValue(T,"isOrthographic",y.isOrthographicCamera===!0),M!==y&&(M=y,je=!0,Ws=!0)}if(F.isSkinnedMesh){me.setOptional(T,F,"bindMatrix"),me.setOptional(T,F,"bindMatrixInverse");const Qe=F.skeleton;Qe&&(Qe.boneTexture===null&&Qe.computeBoneTexture(),me.setValue(T,"boneTexture",Qe.boneTexture,S))}F.isBatchedMesh&&(me.setOptional(T,F,"batchingTexture"),me.setValue(T,"batchingTexture",F._matricesTexture,S),me.setOptional(T,F,"batchingIdTexture"),me.setValue(T,"batchingIdTexture",F._indirectTexture,S),me.setOptional(T,F,"batchingColorTexture"),F._colorsTexture!==null&&me.setValue(T,"batchingColorTexture",F._colorsTexture,S));const Xs=j.morphAttributes;if((Xs.position!==void 0||Xs.normal!==void 0||Xs.color!==void 0)&&At.update(F,j,fn),(je||Pt.receiveShadow!==F.receiveShadow)&&(Pt.receiveShadow=F.receiveShadow,me.setValue(T,"receiveShadow",F.receiveShadow)),K.isMeshGouraudMaterial&&K.envMap!==null&&(An.envMap.value=Rt,An.flipEnvMap.value=Rt.isCubeTexture&&Rt.isRenderTargetTexture===!1?-1:1),K.isMeshStandardMaterial&&K.envMap===null&&O.environment!==null&&(An.envMapIntensity.value=O.environmentIntensity),je&&(me.setValue(T,"toneMappingExposure",x.toneMappingExposure),Pt.needsLights&&dp(An,Ws),ft&&K.fog===!0&&ct.refreshFogUniforms(An,ft),ct.refreshMaterialUniforms(An,K,z,q,f.state.transmissionRenderTarget[y.id]),Eo.upload(T,eu(Pt),An,S)),K.isShaderMaterial&&K.uniformsNeedUpdate===!0&&(Eo.upload(T,eu(Pt),An,S),K.uniformsNeedUpdate=!1),K.isSpriteMaterial&&me.setValue(T,"center",F.center),me.setValue(T,"modelViewMatrix",F.modelViewMatrix),me.setValue(T,"normalMatrix",F.normalMatrix),me.setValue(T,"modelMatrix",F.matrixWorld),K.isShaderMaterial||K.isRawShaderMaterial){const Qe=K.uniformsGroups;for(let fi=0,di=Qe.length;fi<di;fi++){const iu=Qe[fi];U.update(iu,fn),U.bind(iu,fn)}}return fn}function dp(y,O){y.ambientLightColor.needsUpdate=O,y.lightProbe.needsUpdate=O,y.directionalLights.needsUpdate=O,y.directionalLightShadows.needsUpdate=O,y.pointLights.needsUpdate=O,y.pointLightShadows.needsUpdate=O,y.spotLights.needsUpdate=O,y.spotLightShadows.needsUpdate=O,y.rectAreaLights.needsUpdate=O,y.hemisphereLights.needsUpdate=O}function pp(y){return y.isMeshLambertMaterial||y.isMeshToonMaterial||y.isMeshPhongMaterial||y.isMeshStandardMaterial||y.isShadowMaterial||y.isShaderMaterial&&y.lights===!0}this.getActiveCubeFace=function(){return P},this.getActiveMipmapLevel=function(){return D},this.getRenderTarget=function(){return N},this.setRenderTargetTextures=function(y,O,j){V.get(y.texture).__webglTexture=O,V.get(y.depthTexture).__webglTexture=j;const K=V.get(y);K.__hasExternalTextures=!0,K.__autoAllocateDepthBuffer=j===void 0,K.__autoAllocateDepthBuffer||Z.has("WEBGL_multisampled_render_to_texture")===!0&&(console.warn("THREE.WebGLRenderer: Render-to-texture extension was disabled because an external texture was provided"),K.__useRenderToTexture=!1)},this.setRenderTargetFramebuffer=function(y,O){const j=V.get(y);j.__webglFramebuffer=O,j.__useDefaultFramebuffer=O===void 0},this.setRenderTarget=function(y,O=0,j=0){N=y,P=O,D=j;let K=!0,F=null,ft=!1,Mt=!1;if(y){const Rt=V.get(y);if(Rt.__useDefaultFramebuffer!==void 0)tt.bindFramebuffer(T.FRAMEBUFFER,null),K=!1;else if(Rt.__webglFramebuffer===void 0)S.setupRenderTarget(y);else if(Rt.__hasExternalTextures)S.rebindTextures(y,V.get(y.texture).__webglTexture,V.get(y.depthTexture).__webglTexture);else if(y.depthBuffer){const Ct=y.depthTexture;if(Rt.__boundDepthTexture!==Ct){if(Ct!==null&&V.has(Ct)&&(y.width!==Ct.image.width||y.height!==Ct.image.height))throw new Error("WebGLRenderTarget: Attached DepthTexture is initialized to the incorrect size.");S.setupDepthRenderbuffer(y)}}const Bt=y.texture;(Bt.isData3DTexture||Bt.isDataArrayTexture||Bt.isCompressedArrayTexture)&&(Mt=!0);const Gt=V.get(y).__webglFramebuffer;y.isWebGLCubeRenderTarget?(Array.isArray(Gt[O])?F=Gt[O][j]:F=Gt[O],ft=!0):y.samples>0&&S.useMultisampledRTT(y)===!1?F=V.get(y).__webglMultisampledFramebuffer:Array.isArray(Gt)?F=Gt[j]:F=Gt,L.copy(y.viewport),J.copy(y.scissor),C=y.scissorTest}else L.copy(bt).multiplyScalar(z).floor(),J.copy(Ut).multiplyScalar(z).floor(),C=ee;if(tt.bindFramebuffer(T.FRAMEBUFFER,F)&&K&&tt.drawBuffers(y,F),tt.viewport(L),tt.scissor(J),tt.setScissorTest(C),ft){const Rt=V.get(y.texture);T.framebufferTexture2D(T.FRAMEBUFFER,T.COLOR_ATTACHMENT0,T.TEXTURE_CUBE_MAP_POSITIVE_X+O,Rt.__webglTexture,j)}else if(Mt){const Rt=V.get(y.texture),Bt=O||0;T.framebufferTextureLayer(T.FRAMEBUFFER,T.COLOR_ATTACHMENT0,Rt.__webglTexture,j||0,Bt)}E=-1},this.readRenderTargetPixels=function(y,O,j,K,F,ft,Mt){if(!(y&&y.isWebGLRenderTarget)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");return}let wt=V.get(y).__webglFramebuffer;if(y.isWebGLCubeRenderTarget&&Mt!==void 0&&(wt=wt[Mt]),wt){tt.bindFramebuffer(T.FRAMEBUFFER,wt);try{const Rt=y.texture,Bt=Rt.format,Gt=Rt.type;if(!st.textureFormatReadable(Bt)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in RGBA or implementation defined format.");return}if(!st.textureTypeReadable(Gt)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in UnsignedByteType or implementation defined type.");return}O>=0&&O<=y.width-K&&j>=0&&j<=y.height-F&&T.readPixels(O,j,K,F,zt.convert(Bt),zt.convert(Gt),ft)}finally{const Rt=N!==null?V.get(N).__webglFramebuffer:null;tt.bindFramebuffer(T.FRAMEBUFFER,Rt)}}},this.readRenderTargetPixelsAsync=async function(y,O,j,K,F,ft,Mt){if(!(y&&y.isWebGLRenderTarget))throw new Error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");let wt=V.get(y).__webglFramebuffer;if(y.isWebGLCubeRenderTarget&&Mt!==void 0&&(wt=wt[Mt]),wt){const Rt=y.texture,Bt=Rt.format,Gt=Rt.type;if(!st.textureFormatReadable(Bt))throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in RGBA or implementation defined format.");if(!st.textureTypeReadable(Gt))throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: renderTarget is not in UnsignedByteType or implementation defined type.");if(O>=0&&O<=y.width-K&&j>=0&&j<=y.height-F){tt.bindFramebuffer(T.FRAMEBUFFER,wt);const Ct=T.createBuffer();T.bindBuffer(T.PIXEL_PACK_BUFFER,Ct),T.bufferData(T.PIXEL_PACK_BUFFER,ft.byteLength,T.STREAM_READ),T.readPixels(O,j,K,F,zt.convert(Bt),zt.convert(Gt),0);const Qt=N!==null?V.get(N).__webglFramebuffer:null;tt.bindFramebuffer(T.FRAMEBUFFER,Qt);const fe=T.fenceSync(T.SYNC_GPU_COMMANDS_COMPLETE,0);return T.flush(),await Cg(T,fe,4),T.bindBuffer(T.PIXEL_PACK_BUFFER,Ct),T.getBufferSubData(T.PIXEL_PACK_BUFFER,0,ft),T.deleteBuffer(Ct),T.deleteSync(fe),ft}else throw new Error("THREE.WebGLRenderer.readRenderTargetPixelsAsync: requested read bounds are out of range.")}},this.copyFramebufferToTexture=function(y,O=null,j=0){y.isTexture!==!0&&(sr("WebGLRenderer: copyFramebufferToTexture function signature has changed."),O=arguments[0]||null,y=arguments[1]);const K=Math.pow(2,-j),F=Math.floor(y.image.width*K),ft=Math.floor(y.image.height*K),Mt=O!==null?O.x:0,wt=O!==null?O.y:0;S.setTexture2D(y,0),T.copyTexSubImage2D(T.TEXTURE_2D,j,0,0,Mt,wt,F,ft),tt.unbindTexture()},this.copyTextureToTexture=function(y,O,j=null,K=null,F=0){y.isTexture!==!0&&(sr("WebGLRenderer: copyTextureToTexture function signature has changed."),K=arguments[0]||null,y=arguments[1],O=arguments[2],F=arguments[3]||0,j=null);let ft,Mt,wt,Rt,Bt,Gt,Ct,Qt,fe;const pe=y.isCompressedTexture?y.mipmaps[F]:y.image;j!==null?(ft=j.max.x-j.min.x,Mt=j.max.y-j.min.y,wt=j.isBox3?j.max.z-j.min.z:1,Rt=j.min.x,Bt=j.min.y,Gt=j.isBox3?j.min.z:0):(ft=pe.width,Mt=pe.height,wt=pe.depth||1,Rt=0,Bt=0,Gt=0),K!==null?(Ct=K.x,Qt=K.y,fe=K.z):(Ct=0,Qt=0,fe=0);const ke=zt.convert(O.format),ne=zt.convert(O.type);let Pt;O.isData3DTexture?(S.setTexture3D(O,0),Pt=T.TEXTURE_3D):O.isDataArrayTexture||O.isCompressedArrayTexture?(S.setTexture2DArray(O,0),Pt=T.TEXTURE_2D_ARRAY):(S.setTexture2D(O,0),Pt=T.TEXTURE_2D),T.pixelStorei(T.UNPACK_FLIP_Y_WEBGL,O.flipY),T.pixelStorei(T.UNPACK_PREMULTIPLY_ALPHA_WEBGL,O.premultiplyAlpha),T.pixelStorei(T.UNPACK_ALIGNMENT,O.unpackAlignment);const jn=T.getParameter(T.UNPACK_ROW_LENGTH),ie=T.getParameter(T.UNPACK_IMAGE_HEIGHT),fn=T.getParameter(T.UNPACK_SKIP_PIXELS),as=T.getParameter(T.UNPACK_SKIP_ROWS),je=T.getParameter(T.UNPACK_SKIP_IMAGES);T.pixelStorei(T.UNPACK_ROW_LENGTH,pe.width),T.pixelStorei(T.UNPACK_IMAGE_HEIGHT,pe.height),T.pixelStorei(T.UNPACK_SKIP_PIXELS,Rt),T.pixelStorei(T.UNPACK_SKIP_ROWS,Bt),T.pixelStorei(T.UNPACK_SKIP_IMAGES,Gt);const Ws=y.isDataArrayTexture||y.isData3DTexture,me=O.isDataArrayTexture||O.isData3DTexture;if(y.isRenderTargetTexture||y.isDepthTexture){const An=V.get(y),Xs=V.get(O),Qe=V.get(An.__renderTarget),fi=V.get(Xs.__renderTarget);tt.bindFramebuffer(T.READ_FRAMEBUFFER,Qe.__webglFramebuffer),tt.bindFramebuffer(T.DRAW_FRAMEBUFFER,fi.__webglFramebuffer);for(let di=0;di<wt;di++)Ws&&T.framebufferTextureLayer(T.READ_FRAMEBUFFER,T.COLOR_ATTACHMENT0,V.get(y).__webglTexture,F,Gt+di),y.isDepthTexture?(me&&T.framebufferTextureLayer(T.DRAW_FRAMEBUFFER,T.COLOR_ATTACHMENT0,V.get(O).__webglTexture,F,fe+di),T.blitFramebuffer(Rt,Bt,ft,Mt,Ct,Qt,ft,Mt,T.DEPTH_BUFFER_BIT,T.NEAREST)):me?T.copyTexSubImage3D(Pt,F,Ct,Qt,fe+di,Rt,Bt,ft,Mt):T.copyTexSubImage2D(Pt,F,Ct,Qt,fe+di,Rt,Bt,ft,Mt);tt.bindFramebuffer(T.READ_FRAMEBUFFER,null),tt.bindFramebuffer(T.DRAW_FRAMEBUFFER,null)}else me?y.isDataTexture||y.isData3DTexture?T.texSubImage3D(Pt,F,Ct,Qt,fe,ft,Mt,wt,ke,ne,pe.data):O.isCompressedArrayTexture?T.compressedTexSubImage3D(Pt,F,Ct,Qt,fe,ft,Mt,wt,ke,pe.data):T.texSubImage3D(Pt,F,Ct,Qt,fe,ft,Mt,wt,ke,ne,pe):y.isDataTexture?T.texSubImage2D(T.TEXTURE_2D,F,Ct,Qt,ft,Mt,ke,ne,pe.data):y.isCompressedTexture?T.compressedTexSubImage2D(T.TEXTURE_2D,F,Ct,Qt,pe.width,pe.height,ke,pe.data):T.texSubImage2D(T.TEXTURE_2D,F,Ct,Qt,ft,Mt,ke,ne,pe);T.pixelStorei(T.UNPACK_ROW_LENGTH,jn),T.pixelStorei(T.UNPACK_IMAGE_HEIGHT,ie),T.pixelStorei(T.UNPACK_SKIP_PIXELS,fn),T.pixelStorei(T.UNPACK_SKIP_ROWS,as),T.pixelStorei(T.UNPACK_SKIP_IMAGES,je),F===0&&O.generateMipmaps&&T.generateMipmap(Pt),tt.unbindTexture()},this.copyTextureToTexture3D=function(y,O,j=null,K=null,F=0){return y.isTexture!==!0&&(sr("WebGLRenderer: copyTextureToTexture3D function signature has changed."),j=arguments[0]||null,K=arguments[1]||null,y=arguments[2],O=arguments[3],F=arguments[4]||0),sr('WebGLRenderer: copyTextureToTexture3D function has been deprecated. Use "copyTextureToTexture" instead.'),this.copyTextureToTexture(y,O,j,K,F)},this.initRenderTarget=function(y){V.get(y).__webglFramebuffer===void 0&&S.setupRenderTarget(y)},this.initTexture=function(y){y.isCubeTexture?S.setTextureCube(y,0):y.isData3DTexture?S.setTexture3D(y,0):y.isDataArrayTexture||y.isCompressedArrayTexture?S.setTexture2DArray(y,0):S.setTexture2D(y,0),tt.unbindTexture()},this.resetState=function(){P=0,D=0,N=null,tt.reset(),he.reset()},typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}get coordinateSystem(){return oi}get outputColorSpace(){return this._outputColorSpace}set outputColorSpace(t){this._outputColorSpace=t;const e=this.getContext();e.drawingBufferColorspace=Jt._getDrawingBufferColorSpace(t),e.unpackColorSpace=Jt._getUnpackColorSpace()}}class zc{constructor(t,e=1,i=1e3){this.isFog=!0,this.name="",this.color=new $t(t),this.near=e,this.far=i}clone(){return new zc(this.color,this.near,this.far)}toJSON(){return{type:"Fog",name:this.name,color:this.color.getHex(),near:this.near,far:this.far}}}class kM extends Ae{constructor(){super(),this.isScene=!0,this.type="Scene",this.background=null,this.environment=null,this.fog=null,this.backgroundBlurriness=0,this.backgroundIntensity=1,this.backgroundRotation=new Gn,this.environmentIntensity=1,this.environmentRotation=new Gn,this.overrideMaterial=null,typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}copy(t,e){return super.copy(t,e),t.background!==null&&(this.background=t.background.clone()),t.environment!==null&&(this.environment=t.environment.clone()),t.fog!==null&&(this.fog=t.fog.clone()),this.backgroundBlurriness=t.backgroundBlurriness,this.backgroundIntensity=t.backgroundIntensity,this.backgroundRotation.copy(t.backgroundRotation),this.environmentIntensity=t.environmentIntensity,this.environmentRotation.copy(t.environmentRotation),t.overrideMaterial!==null&&(this.overrideMaterial=t.overrideMaterial.clone()),this.matrixAutoUpdate=t.matrixAutoUpdate,this}toJSON(t){const e=super.toJSON(t);return this.fog!==null&&(e.object.fog=this.fog.toJSON()),this.backgroundBlurriness>0&&(e.object.backgroundBlurriness=this.backgroundBlurriness),this.backgroundIntensity!==1&&(e.object.backgroundIntensity=this.backgroundIntensity),e.object.backgroundRotation=this.backgroundRotation.toArray(),this.environmentIntensity!==1&&(e.object.environmentIntensity=this.environmentIntensity),e.object.environmentRotation=this.environmentRotation.toArray(),e}}class HM extends ze{constructor(t=null,e=1,i=1,s,r,o,a,l,u=Je,c=Je,h,d){super(null,o,a,l,u,c,s,r,h,d),this.isDataTexture=!0,this.image={data:t,width:e,height:i},this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}}class Oh extends En{constructor(t,e,i,s=1){super(t,e,i),this.isInstancedBufferAttribute=!0,this.meshPerAttribute=s}copy(t){return super.copy(t),this.meshPerAttribute=t.meshPerAttribute,this}toJSON(){const t=super.toJSON();return t.meshPerAttribute=this.meshPerAttribute,t.isInstancedBufferAttribute=!0,t}}const Es=new ue,Fh=new ue,lo=[],Bh=new os,VM=new ue,Qs=new qe,tr=new Dr;class GM extends qe{constructor(t,e,i){super(t,e),this.isInstancedMesh=!0,this.instanceMatrix=new Oh(new Float32Array(i*16),16),this.instanceColor=null,this.morphTexture=null,this.count=i,this.boundingBox=null,this.boundingSphere=null;for(let s=0;s<i;s++)this.setMatrixAt(s,VM)}computeBoundingBox(){const t=this.geometry,e=this.count;this.boundingBox===null&&(this.boundingBox=new os),t.boundingBox===null&&t.computeBoundingBox(),this.boundingBox.makeEmpty();for(let i=0;i<e;i++)this.getMatrixAt(i,Es),Bh.copy(t.boundingBox).applyMatrix4(Es),this.boundingBox.union(Bh)}computeBoundingSphere(){const t=this.geometry,e=this.count;this.boundingSphere===null&&(this.boundingSphere=new Dr),t.boundingSphere===null&&t.computeBoundingSphere(),this.boundingSphere.makeEmpty();for(let i=0;i<e;i++)this.getMatrixAt(i,Es),tr.copy(t.boundingSphere).applyMatrix4(Es),this.boundingSphere.union(tr)}copy(t,e){return super.copy(t,e),this.instanceMatrix.copy(t.instanceMatrix),t.morphTexture!==null&&(this.morphTexture=t.morphTexture.clone()),t.instanceColor!==null&&(this.instanceColor=t.instanceColor.clone()),this.count=t.count,t.boundingBox!==null&&(this.boundingBox=t.boundingBox.clone()),t.boundingSphere!==null&&(this.boundingSphere=t.boundingSphere.clone()),this}getColorAt(t,e){e.fromArray(this.instanceColor.array,t*3)}getMatrixAt(t,e){e.fromArray(this.instanceMatrix.array,t*16)}getMorphAt(t,e){const i=e.morphTargetInfluences,s=this.morphTexture.source.data.data,r=i.length+1,o=t*r+1;for(let a=0;a<i.length;a++)i[a]=s[o+a]}raycast(t,e){const i=this.matrixWorld,s=this.count;if(Qs.geometry=this.geometry,Qs.material=this.material,Qs.material!==void 0&&(this.boundingSphere===null&&this.computeBoundingSphere(),tr.copy(this.boundingSphere),tr.applyMatrix4(i),t.ray.intersectsSphere(tr)!==!1))for(let r=0;r<s;r++){this.getMatrixAt(r,Es),Fh.multiplyMatrices(i,Es),Qs.matrixWorld=Fh,Qs.raycast(t,lo);for(let o=0,a=lo.length;o<a;o++){const l=lo[o];l.instanceId=r,l.object=this,e.push(l)}lo.length=0}}setColorAt(t,e){this.instanceColor===null&&(this.instanceColor=new Oh(new Float32Array(this.instanceMatrix.count*3).fill(1),3)),e.toArray(this.instanceColor.array,t*3)}setMatrixAt(t,e){e.toArray(this.instanceMatrix.array,t*16)}setMorphAt(t,e){const i=e.morphTargetInfluences,s=i.length+1;this.morphTexture===null&&(this.morphTexture=new HM(new Float32Array(s*this.count),s,this.count,Ic,On));const r=this.morphTexture.source.data.data;let o=0;for(let u=0;u<i.length;u++)o+=i[u];const a=this.geometry.morphTargetsRelative?1:1-o,l=s*t;r[l]=a,r.set(i,l+1)}updateMorphTargets(){}dispose(){return this.dispatchEvent({type:"dispose"}),this.morphTexture!==null&&(this.morphTexture.dispose(),this.morphTexture=null),this}}class kc extends qn{constructor(t=1,e=1,i=1,s=32,r=1,o=!1,a=0,l=Math.PI*2){super(),this.type="CylinderGeometry",this.parameters={radiusTop:t,radiusBottom:e,height:i,radialSegments:s,heightSegments:r,openEnded:o,thetaStart:a,thetaLength:l};const u=this;s=Math.floor(s),r=Math.floor(r);const c=[],h=[],d=[],p=[];let g=0;const v=[],m=i/2;let f=0;w(),o===!1&&(t>0&&b(!0),e>0&&b(!1)),this.setIndex(c),this.setAttribute("position",new Ie(h,3)),this.setAttribute("normal",new Ie(d,3)),this.setAttribute("uv",new Ie(p,2));function w(){const x=new G,B=new G;let P=0;const D=(e-t)/i;for(let N=0;N<=r;N++){const E=[],M=N/r,L=M*(e-t)+t;for(let J=0;J<=s;J++){const C=J/s,k=C*l+a,Y=Math.sin(k),H=Math.cos(k);B.x=L*Y,B.y=-M*i+m,B.z=L*H,h.push(B.x,B.y,B.z),x.set(Y,D,H).normalize(),d.push(x.x,x.y,x.z),p.push(C,1-M),E.push(g++)}v.push(E)}for(let N=0;N<s;N++)for(let E=0;E<r;E++){const M=v[E][N],L=v[E+1][N],J=v[E+1][N+1],C=v[E][N+1];(t>0||E!==0)&&(c.push(M,L,C),P+=3),(e>0||E!==r-1)&&(c.push(L,J,C),P+=3)}u.addGroup(f,P,0),f+=P}function b(x){const B=g,P=new kt,D=new G;let N=0;const E=x===!0?t:e,M=x===!0?1:-1;for(let J=1;J<=s;J++)h.push(0,m*M,0),d.push(0,M,0),p.push(.5,.5),g++;const L=g;for(let J=0;J<=s;J++){const k=J/s*l+a,Y=Math.cos(k),H=Math.sin(k);D.x=E*H,D.y=m*M,D.z=E*Y,h.push(D.x,D.y,D.z),d.push(0,M,0),P.x=Y*.5+.5,P.y=H*.5*M+.5,p.push(P.x,P.y),g++}for(let J=0;J<s;J++){const C=B+J,k=L+J;x===!0?c.push(k,k+1,C):c.push(k+1,k,C),N+=3}u.addGroup(f,N,x===!0?1:2),f+=N}}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new kc(t.radiusTop,t.radiusBottom,t.height,t.radialSegments,t.heightSegments,t.openEnded,t.thetaStart,t.thetaLength)}}class Hc extends qn{constructor(t=.5,e=1,i=32,s=1,r=0,o=Math.PI*2){super(),this.type="RingGeometry",this.parameters={innerRadius:t,outerRadius:e,thetaSegments:i,phiSegments:s,thetaStart:r,thetaLength:o},i=Math.max(3,i),s=Math.max(1,s);const a=[],l=[],u=[],c=[];let h=t;const d=(e-t)/s,p=new G,g=new kt;for(let v=0;v<=s;v++){for(let m=0;m<=i;m++){const f=r+m/i*o;p.x=h*Math.cos(f),p.y=h*Math.sin(f),l.push(p.x,p.y,p.z),u.push(0,0,1),g.x=(p.x/e+1)/2,g.y=(p.y/e+1)/2,c.push(g.x,g.y)}h+=d}for(let v=0;v<s;v++){const m=v*(i+1);for(let f=0;f<i;f++){const w=f+m,b=w,x=w+i+1,B=w+i+2,P=w+1;a.push(b,x,P),a.push(x,B,P)}}this.setIndex(a),this.setAttribute("position",new Ie(l,3)),this.setAttribute("normal",new Ie(u,3)),this.setAttribute("uv",new Ie(c,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new Hc(t.innerRadius,t.outerRadius,t.thetaSegments,t.phiSegments,t.thetaStart,t.thetaLength)}}class pr extends qn{constructor(t=1,e=32,i=16,s=0,r=Math.PI*2,o=0,a=Math.PI){super(),this.type="SphereGeometry",this.parameters={radius:t,widthSegments:e,heightSegments:i,phiStart:s,phiLength:r,thetaStart:o,thetaLength:a},e=Math.max(3,Math.floor(e)),i=Math.max(2,Math.floor(i));const l=Math.min(o+a,Math.PI);let u=0;const c=[],h=new G,d=new G,p=[],g=[],v=[],m=[];for(let f=0;f<=i;f++){const w=[],b=f/i;let x=0;f===0&&o===0?x=.5/e:f===i&&l===Math.PI&&(x=-.5/e);for(let B=0;B<=e;B++){const P=B/e;h.x=-t*Math.cos(s+P*r)*Math.sin(o+b*a),h.y=t*Math.cos(o+b*a),h.z=t*Math.sin(s+P*r)*Math.sin(o+b*a),g.push(h.x,h.y,h.z),d.copy(h).normalize(),v.push(d.x,d.y,d.z),m.push(P+x,1-b),w.push(u++)}c.push(w)}for(let f=0;f<i;f++)for(let w=0;w<e;w++){const b=c[f][w+1],x=c[f][w],B=c[f+1][w],P=c[f+1][w+1];(f!==0||o>0)&&p.push(b,x,P),(f!==i-1||l<Math.PI)&&p.push(x,B,P)}this.setIndex(p),this.setAttribute("position",new Ie(g,3)),this.setAttribute("normal",new Ie(v,3)),this.setAttribute("uv",new Ie(m,2))}copy(t){return super.copy(t),this.parameters=Object.assign({},t.parameters),this}static fromJSON(t){return new pr(t.radius,t.widthSegments,t.heightSegments,t.phiStart,t.phiLength,t.thetaStart,t.thetaLength)}}class zh extends Lr{static get type(){return"MeshLambertMaterial"}constructor(t){super(),this.isMeshLambertMaterial=!0,this.color=new $t(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new $t(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=Ad,this.normalScale=new kt(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.envMapRotation=new Gn,this.combine=Cc,this.reflectivity=1,this.refractionRatio=.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(t)}copy(t){return super.copy(t),this.color.copy(t.color),this.map=t.map,this.lightMap=t.lightMap,this.lightMapIntensity=t.lightMapIntensity,this.aoMap=t.aoMap,this.aoMapIntensity=t.aoMapIntensity,this.emissive.copy(t.emissive),this.emissiveMap=t.emissiveMap,this.emissiveIntensity=t.emissiveIntensity,this.bumpMap=t.bumpMap,this.bumpScale=t.bumpScale,this.normalMap=t.normalMap,this.normalMapType=t.normalMapType,this.normalScale.copy(t.normalScale),this.displacementMap=t.displacementMap,this.displacementScale=t.displacementScale,this.displacementBias=t.displacementBias,this.specularMap=t.specularMap,this.alphaMap=t.alphaMap,this.envMap=t.envMap,this.envMapRotation.copy(t.envMapRotation),this.combine=t.combine,this.reflectivity=t.reflectivity,this.refractionRatio=t.refractionRatio,this.wireframe=t.wireframe,this.wireframeLinewidth=t.wireframeLinewidth,this.wireframeLinecap=t.wireframeLinecap,this.wireframeLinejoin=t.wireframeLinejoin,this.flatShading=t.flatShading,this.fog=t.fog,this}}class qd extends Ae{constructor(t,e=1){super(),this.isLight=!0,this.type="Light",this.color=new $t(t),this.intensity=e}dispose(){}copy(t,e){return super.copy(t,e),this.color.copy(t.color),this.intensity=t.intensity,this}toJSON(t){const e=super.toJSON(t);return e.object.color=this.color.getHex(),e.object.intensity=this.intensity,this.groundColor!==void 0&&(e.object.groundColor=this.groundColor.getHex()),this.distance!==void 0&&(e.object.distance=this.distance),this.angle!==void 0&&(e.object.angle=this.angle),this.decay!==void 0&&(e.object.decay=this.decay),this.penumbra!==void 0&&(e.object.penumbra=this.penumbra),this.shadow!==void 0&&(e.object.shadow=this.shadow.toJSON()),this.target!==void 0&&(e.object.target=this.target.uuid),e}}class WM extends qd{constructor(t,e,i){super(t,i),this.isHemisphereLight=!0,this.type="HemisphereLight",this.position.copy(Ae.DEFAULT_UP),this.updateMatrix(),this.groundColor=new $t(e)}copy(t,e){return super.copy(t,e),this.groundColor.copy(t.groundColor),this}}const Ja=new ue,kh=new G,Hh=new G;class XM{constructor(t){this.camera=t,this.intensity=1,this.bias=0,this.normalBias=0,this.radius=1,this.blurSamples=8,this.mapSize=new kt(512,512),this.map=null,this.mapPass=null,this.matrix=new ue,this.autoUpdate=!0,this.needsUpdate=!1,this._frustum=new Fc,this._frameExtents=new kt(1,1),this._viewportCount=1,this._viewports=[new ge(0,0,1,1)]}getViewportCount(){return this._viewportCount}getFrustum(){return this._frustum}updateMatrices(t){const e=this.camera,i=this.matrix;kh.setFromMatrixPosition(t.matrixWorld),e.position.copy(kh),Hh.setFromMatrixPosition(t.target.matrixWorld),e.lookAt(Hh),e.updateMatrixWorld(),Ja.multiplyMatrices(e.projectionMatrix,e.matrixWorldInverse),this._frustum.setFromProjectionMatrix(Ja),i.set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1),i.multiply(Ja)}getViewport(t){return this._viewports[t]}getFrameExtents(){return this._frameExtents}dispose(){this.map&&this.map.dispose(),this.mapPass&&this.mapPass.dispose()}copy(t){return this.camera=t.camera.clone(),this.intensity=t.intensity,this.bias=t.bias,this.radius=t.radius,this.mapSize.copy(t.mapSize),this}clone(){return new this.constructor().copy(this)}toJSON(){const t={};return this.intensity!==1&&(t.intensity=this.intensity),this.bias!==0&&(t.bias=this.bias),this.normalBias!==0&&(t.normalBias=this.normalBias),this.radius!==1&&(t.radius=this.radius),(this.mapSize.x!==512||this.mapSize.y!==512)&&(t.mapSize=this.mapSize.toArray()),t.camera=this.camera.toJSON(!1).object,delete t.camera.matrix,t}}class qM extends XM{constructor(){super(new kd(-5,5,5,-5,.5,500)),this.isDirectionalLightShadow=!0}}class YM extends qd{constructor(t,e){super(t,e),this.isDirectionalLight=!0,this.type="DirectionalLight",this.position.copy(Ae.DEFAULT_UP),this.updateMatrix(),this.target=new Ae,this.shadow=new qM}dispose(){this.shadow.dispose()}copy(t){return super.copy(t),this.target=t.target.clone(),this.shadow=t.shadow.clone(),this}}class Vh{constructor(t=1,e=0,i=0){return this.radius=t,this.phi=e,this.theta=i,this}set(t,e,i){return this.radius=t,this.phi=e,this.theta=i,this}copy(t){return this.radius=t.radius,this.phi=t.phi,this.theta=t.theta,this}makeSafe(){return this.phi=Math.max(1e-6,Math.min(Math.PI-1e-6,this.phi)),this}setFromVector3(t){return this.setFromCartesianCoords(t.x,t.y,t.z)}setFromCartesianCoords(t,e,i){return this.radius=Math.sqrt(t*t+e*e+i*i),this.radius===0?(this.theta=0,this.phi=0):(this.theta=Math.atan2(t,i),this.phi=Math.acos(Fe(e/this.radius,-1,1))),this}clone(){return new this.constructor().copy(this)}}class jM extends rs{constructor(t,e=null){super(),this.object=t,this.domElement=e,this.enabled=!0,this.state=-1,this.keys={},this.mouseButtons={LEFT:null,MIDDLE:null,RIGHT:null},this.touches={ONE:null,TWO:null}}connect(){}disconnect(){}dispose(){}update(){}}typeof __THREE_DEVTOOLS__<"u"&&__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register",{detail:{revision:ea}}));typeof window<"u"&&(window.__THREE__?console.warn("WARNING: Multiple instances of Three.js being imported."):window.__THREE__=ea);const ic=()=>{const n=window;return n.__t4||(n.__t4={renderers:[],renders:0,lastScene:null,lastCamera:null,glErrors:[],contextLost:0,contexts:[],patched:!1}),n.__t4},Gh=ic();if(!Gh.patched){const n=ko.prototype,t=n.render;n.render=function(i,s){var o,a;const r=ic();if(r.renderers.indexOf(this)<0){r.renderers.push(this);try{const l=this.getContext();r.contexts.indexOf(l)<0&&r.contexts.push(l),(a=(o=this.domElement)==null?void 0:o.addEventListener)==null||a.call(o,"webglcontextlost",()=>{r.contextLost++})}catch(l){r.glErrors.push("getContext: "+String(l))}}return r.renders++,r.lastScene=i,r.lastCamera=s,t.call(this,i,s)};const e=n.dispose;n.dispose=function(){const i=ic();return i.disposed=(i.disposed||0)+1,e.call(this)},Gh.patched=!0}const Wh={type:"change"},Vc={type:"start"},Yd={type:"end"},co=new Dd,Xh=new Mi,KM=Math.cos(70*wg.DEG2RAD),Me=new G,Ve=2*Math.PI,le={NONE:-1,ROTATE:0,DOLLY:1,PAN:2,TOUCH_ROTATE:3,TOUCH_PAN:4,TOUCH_DOLLY_PAN:5,TOUCH_DOLLY_ROTATE:6},Qa=1e-6;class $M extends jM{constructor(t,e=null){super(t,e),this.state=le.NONE,this.enabled=!0,this.target=new G,this.cursor=new G,this.minDistance=0,this.maxDistance=1/0,this.minZoom=0,this.maxZoom=1/0,this.minTargetRadius=0,this.maxTargetRadius=1/0,this.minPolarAngle=0,this.maxPolarAngle=Math.PI,this.minAzimuthAngle=-1/0,this.maxAzimuthAngle=1/0,this.enableDamping=!1,this.dampingFactor=.05,this.enableZoom=!0,this.zoomSpeed=1,this.enableRotate=!0,this.rotateSpeed=1,this.enablePan=!0,this.panSpeed=1,this.screenSpacePanning=!0,this.keyPanSpeed=7,this.zoomToCursor=!1,this.autoRotate=!1,this.autoRotateSpeed=2,this.keys={LEFT:"ArrowLeft",UP:"ArrowUp",RIGHT:"ArrowRight",BOTTOM:"ArrowDown"},this.mouseButtons={LEFT:Cs.ROTATE,MIDDLE:Cs.DOLLY,RIGHT:Cs.PAN},this.touches={ONE:As.ROTATE,TWO:As.DOLLY_PAN},this.target0=this.target.clone(),this.position0=this.object.position.clone(),this.zoom0=this.object.zoom,this._domElementKeyEvents=null,this._lastPosition=new G,this._lastQuaternion=new Di,this._lastTargetPosition=new G,this._quat=new Di().setFromUnitVectors(t.up,new G(0,1,0)),this._quatInverse=this._quat.clone().invert(),this._spherical=new Vh,this._sphericalDelta=new Vh,this._scale=1,this._panOffset=new G,this._rotateStart=new kt,this._rotateEnd=new kt,this._rotateDelta=new kt,this._panStart=new kt,this._panEnd=new kt,this._panDelta=new kt,this._dollyStart=new kt,this._dollyEnd=new kt,this._dollyDelta=new kt,this._dollyDirection=new G,this._mouse=new kt,this._performCursorZoom=!1,this._pointers=[],this._pointerPositions={},this._controlActive=!1,this._onPointerMove=JM.bind(this),this._onPointerDown=ZM.bind(this),this._onPointerUp=QM.bind(this),this._onContextMenu=oS.bind(this),this._onMouseWheel=nS.bind(this),this._onKeyDown=iS.bind(this),this._onTouchStart=sS.bind(this),this._onTouchMove=rS.bind(this),this._onMouseDown=tS.bind(this),this._onMouseMove=eS.bind(this),this._interceptControlDown=aS.bind(this),this._interceptControlUp=lS.bind(this),this.domElement!==null&&this.connect(),this.update()}connect(){this.domElement.addEventListener("pointerdown",this._onPointerDown),this.domElement.addEventListener("pointercancel",this._onPointerUp),this.domElement.addEventListener("contextmenu",this._onContextMenu),this.domElement.addEventListener("wheel",this._onMouseWheel,{passive:!1}),this.domElement.getRootNode().addEventListener("keydown",this._interceptControlDown,{passive:!0,capture:!0}),this.domElement.style.touchAction="none"}disconnect(){this.domElement.removeEventListener("pointerdown",this._onPointerDown),this.domElement.removeEventListener("pointermove",this._onPointerMove),this.domElement.removeEventListener("pointerup",this._onPointerUp),this.domElement.removeEventListener("pointercancel",this._onPointerUp),this.domElement.removeEventListener("wheel",this._onMouseWheel),this.domElement.removeEventListener("contextmenu",this._onContextMenu),this.stopListenToKeyEvents(),this.domElement.getRootNode().removeEventListener("keydown",this._interceptControlDown,{capture:!0}),this.domElement.style.touchAction="auto"}dispose(){this.disconnect()}getPolarAngle(){return this._spherical.phi}getAzimuthalAngle(){return this._spherical.theta}getDistance(){return this.object.position.distanceTo(this.target)}listenToKeyEvents(t){t.addEventListener("keydown",this._onKeyDown),this._domElementKeyEvents=t}stopListenToKeyEvents(){this._domElementKeyEvents!==null&&(this._domElementKeyEvents.removeEventListener("keydown",this._onKeyDown),this._domElementKeyEvents=null)}saveState(){this.target0.copy(this.target),this.position0.copy(this.object.position),this.zoom0=this.object.zoom}reset(){this.target.copy(this.target0),this.object.position.copy(this.position0),this.object.zoom=this.zoom0,this.object.updateProjectionMatrix(),this.dispatchEvent(Wh),this.update(),this.state=le.NONE}update(t=null){const e=this.object.position;Me.copy(e).sub(this.target),Me.applyQuaternion(this._quat),this._spherical.setFromVector3(Me),this.autoRotate&&this.state===le.NONE&&this._rotateLeft(this._getAutoRotationAngle(t)),this.enableDamping?(this._spherical.theta+=this._sphericalDelta.theta*this.dampingFactor,this._spherical.phi+=this._sphericalDelta.phi*this.dampingFactor):(this._spherical.theta+=this._sphericalDelta.theta,this._spherical.phi+=this._sphericalDelta.phi);let i=this.minAzimuthAngle,s=this.maxAzimuthAngle;isFinite(i)&&isFinite(s)&&(i<-Math.PI?i+=Ve:i>Math.PI&&(i-=Ve),s<-Math.PI?s+=Ve:s>Math.PI&&(s-=Ve),i<=s?this._spherical.theta=Math.max(i,Math.min(s,this._spherical.theta)):this._spherical.theta=this._spherical.theta>(i+s)/2?Math.max(i,this._spherical.theta):Math.min(s,this._spherical.theta)),this._spherical.phi=Math.max(this.minPolarAngle,Math.min(this.maxPolarAngle,this._spherical.phi)),this._spherical.makeSafe(),this.enableDamping===!0?this.target.addScaledVector(this._panOffset,this.dampingFactor):this.target.add(this._panOffset),this.target.sub(this.cursor),this.target.clampLength(this.minTargetRadius,this.maxTargetRadius),this.target.add(this.cursor);let r=!1;if(this.zoomToCursor&&this._performCursorZoom||this.object.isOrthographicCamera)this._spherical.radius=this._clampDistance(this._spherical.radius);else{const o=this._spherical.radius;this._spherical.radius=this._clampDistance(this._spherical.radius*this._scale),r=o!=this._spherical.radius}if(Me.setFromSpherical(this._spherical),Me.applyQuaternion(this._quatInverse),e.copy(this.target).add(Me),this.object.lookAt(this.target),this.enableDamping===!0?(this._sphericalDelta.theta*=1-this.dampingFactor,this._sphericalDelta.phi*=1-this.dampingFactor,this._panOffset.multiplyScalar(1-this.dampingFactor)):(this._sphericalDelta.set(0,0,0),this._panOffset.set(0,0,0)),this.zoomToCursor&&this._performCursorZoom){let o=null;if(this.object.isPerspectiveCamera){const a=Me.length();o=this._clampDistance(a*this._scale);const l=a-o;this.object.position.addScaledVector(this._dollyDirection,l),this.object.updateMatrixWorld(),r=!!l}else if(this.object.isOrthographicCamera){const a=new G(this._mouse.x,this._mouse.y,0);a.unproject(this.object);const l=this.object.zoom;this.object.zoom=Math.max(this.minZoom,Math.min(this.maxZoom,this.object.zoom/this._scale)),this.object.updateProjectionMatrix(),r=l!==this.object.zoom;const u=new G(this._mouse.x,this._mouse.y,0);u.unproject(this.object),this.object.position.sub(u).add(a),this.object.updateMatrixWorld(),o=Me.length()}else console.warn("WARNING: OrbitControls.js encountered an unknown camera type - zoom to cursor disabled."),this.zoomToCursor=!1;o!==null&&(this.screenSpacePanning?this.target.set(0,0,-1).transformDirection(this.object.matrix).multiplyScalar(o).add(this.object.position):(co.origin.copy(this.object.position),co.direction.set(0,0,-1).transformDirection(this.object.matrix),Math.abs(this.object.up.dot(co.direction))<KM?this.object.lookAt(this.target):(Xh.setFromNormalAndCoplanarPoint(this.object.up,this.target),co.intersectPlane(Xh,this.target))))}else if(this.object.isOrthographicCamera){const o=this.object.zoom;this.object.zoom=Math.max(this.minZoom,Math.min(this.maxZoom,this.object.zoom/this._scale)),o!==this.object.zoom&&(this.object.updateProjectionMatrix(),r=!0)}return this._scale=1,this._performCursorZoom=!1,r||this._lastPosition.distanceToSquared(this.object.position)>Qa||8*(1-this._lastQuaternion.dot(this.object.quaternion))>Qa||this._lastTargetPosition.distanceToSquared(this.target)>Qa?(this.dispatchEvent(Wh),this._lastPosition.copy(this.object.position),this._lastQuaternion.copy(this.object.quaternion),this._lastTargetPosition.copy(this.target),!0):!1}_getAutoRotationAngle(t){return t!==null?Ve/60*this.autoRotateSpeed*t:Ve/60/60*this.autoRotateSpeed}_getZoomScale(t){const e=Math.abs(t*.01);return Math.pow(.95,this.zoomSpeed*e)}_rotateLeft(t){this._sphericalDelta.theta-=t}_rotateUp(t){this._sphericalDelta.phi-=t}_panLeft(t,e){Me.setFromMatrixColumn(e,0),Me.multiplyScalar(-t),this._panOffset.add(Me)}_panUp(t,e){this.screenSpacePanning===!0?Me.setFromMatrixColumn(e,1):(Me.setFromMatrixColumn(e,0),Me.crossVectors(this.object.up,Me)),Me.multiplyScalar(t),this._panOffset.add(Me)}_pan(t,e){const i=this.domElement;if(this.object.isPerspectiveCamera){const s=this.object.position;Me.copy(s).sub(this.target);let r=Me.length();r*=Math.tan(this.object.fov/2*Math.PI/180),this._panLeft(2*t*r/i.clientHeight,this.object.matrix),this._panUp(2*e*r/i.clientHeight,this.object.matrix)}else this.object.isOrthographicCamera?(this._panLeft(t*(this.object.right-this.object.left)/this.object.zoom/i.clientWidth,this.object.matrix),this._panUp(e*(this.object.top-this.object.bottom)/this.object.zoom/i.clientHeight,this.object.matrix)):(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - pan disabled."),this.enablePan=!1)}_dollyOut(t){this.object.isPerspectiveCamera||this.object.isOrthographicCamera?this._scale/=t:(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),this.enableZoom=!1)}_dollyIn(t){this.object.isPerspectiveCamera||this.object.isOrthographicCamera?this._scale*=t:(console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),this.enableZoom=!1)}_updateZoomParameters(t,e){if(!this.zoomToCursor)return;this._performCursorZoom=!0;const i=this.domElement.getBoundingClientRect(),s=t-i.left,r=e-i.top,o=i.width,a=i.height;this._mouse.x=s/o*2-1,this._mouse.y=-(r/a)*2+1,this._dollyDirection.set(this._mouse.x,this._mouse.y,1).unproject(this.object).sub(this.object.position).normalize()}_clampDistance(t){return Math.max(this.minDistance,Math.min(this.maxDistance,t))}_handleMouseDownRotate(t){this._rotateStart.set(t.clientX,t.clientY)}_handleMouseDownDolly(t){this._updateZoomParameters(t.clientX,t.clientX),this._dollyStart.set(t.clientX,t.clientY)}_handleMouseDownPan(t){this._panStart.set(t.clientX,t.clientY)}_handleMouseMoveRotate(t){this._rotateEnd.set(t.clientX,t.clientY),this._rotateDelta.subVectors(this._rotateEnd,this._rotateStart).multiplyScalar(this.rotateSpeed);const e=this.domElement;this._rotateLeft(Ve*this._rotateDelta.x/e.clientHeight),this._rotateUp(Ve*this._rotateDelta.y/e.clientHeight),this._rotateStart.copy(this._rotateEnd),this.update()}_handleMouseMoveDolly(t){this._dollyEnd.set(t.clientX,t.clientY),this._dollyDelta.subVectors(this._dollyEnd,this._dollyStart),this._dollyDelta.y>0?this._dollyOut(this._getZoomScale(this._dollyDelta.y)):this._dollyDelta.y<0&&this._dollyIn(this._getZoomScale(this._dollyDelta.y)),this._dollyStart.copy(this._dollyEnd),this.update()}_handleMouseMovePan(t){this._panEnd.set(t.clientX,t.clientY),this._panDelta.subVectors(this._panEnd,this._panStart).multiplyScalar(this.panSpeed),this._pan(this._panDelta.x,this._panDelta.y),this._panStart.copy(this._panEnd),this.update()}_handleMouseWheel(t){this._updateZoomParameters(t.clientX,t.clientY),t.deltaY<0?this._dollyIn(this._getZoomScale(t.deltaY)):t.deltaY>0&&this._dollyOut(this._getZoomScale(t.deltaY)),this.update()}_handleKeyDown(t){let e=!1;switch(t.code){case this.keys.UP:t.ctrlKey||t.metaKey||t.shiftKey?this._rotateUp(Ve*this.rotateSpeed/this.domElement.clientHeight):this._pan(0,this.keyPanSpeed),e=!0;break;case this.keys.BOTTOM:t.ctrlKey||t.metaKey||t.shiftKey?this._rotateUp(-Ve*this.rotateSpeed/this.domElement.clientHeight):this._pan(0,-this.keyPanSpeed),e=!0;break;case this.keys.LEFT:t.ctrlKey||t.metaKey||t.shiftKey?this._rotateLeft(Ve*this.rotateSpeed/this.domElement.clientHeight):this._pan(this.keyPanSpeed,0),e=!0;break;case this.keys.RIGHT:t.ctrlKey||t.metaKey||t.shiftKey?this._rotateLeft(-Ve*this.rotateSpeed/this.domElement.clientHeight):this._pan(-this.keyPanSpeed,0),e=!0;break}e&&(t.preventDefault(),this.update())}_handleTouchStartRotate(t){if(this._pointers.length===1)this._rotateStart.set(t.pageX,t.pageY);else{const e=this._getSecondPointerPosition(t),i=.5*(t.pageX+e.x),s=.5*(t.pageY+e.y);this._rotateStart.set(i,s)}}_handleTouchStartPan(t){if(this._pointers.length===1)this._panStart.set(t.pageX,t.pageY);else{const e=this._getSecondPointerPosition(t),i=.5*(t.pageX+e.x),s=.5*(t.pageY+e.y);this._panStart.set(i,s)}}_handleTouchStartDolly(t){const e=this._getSecondPointerPosition(t),i=t.pageX-e.x,s=t.pageY-e.y,r=Math.sqrt(i*i+s*s);this._dollyStart.set(0,r)}_handleTouchStartDollyPan(t){this.enableZoom&&this._handleTouchStartDolly(t),this.enablePan&&this._handleTouchStartPan(t)}_handleTouchStartDollyRotate(t){this.enableZoom&&this._handleTouchStartDolly(t),this.enableRotate&&this._handleTouchStartRotate(t)}_handleTouchMoveRotate(t){if(this._pointers.length==1)this._rotateEnd.set(t.pageX,t.pageY);else{const i=this._getSecondPointerPosition(t),s=.5*(t.pageX+i.x),r=.5*(t.pageY+i.y);this._rotateEnd.set(s,r)}this._rotateDelta.subVectors(this._rotateEnd,this._rotateStart).multiplyScalar(this.rotateSpeed);const e=this.domElement;this._rotateLeft(Ve*this._rotateDelta.x/e.clientHeight),this._rotateUp(Ve*this._rotateDelta.y/e.clientHeight),this._rotateStart.copy(this._rotateEnd)}_handleTouchMovePan(t){if(this._pointers.length===1)this._panEnd.set(t.pageX,t.pageY);else{const e=this._getSecondPointerPosition(t),i=.5*(t.pageX+e.x),s=.5*(t.pageY+e.y);this._panEnd.set(i,s)}this._panDelta.subVectors(this._panEnd,this._panStart).multiplyScalar(this.panSpeed),this._pan(this._panDelta.x,this._panDelta.y),this._panStart.copy(this._panEnd)}_handleTouchMoveDolly(t){const e=this._getSecondPointerPosition(t),i=t.pageX-e.x,s=t.pageY-e.y,r=Math.sqrt(i*i+s*s);this._dollyEnd.set(0,r),this._dollyDelta.set(0,Math.pow(this._dollyEnd.y/this._dollyStart.y,this.zoomSpeed)),this._dollyOut(this._dollyDelta.y),this._dollyStart.copy(this._dollyEnd);const o=(t.pageX+e.x)*.5,a=(t.pageY+e.y)*.5;this._updateZoomParameters(o,a)}_handleTouchMoveDollyPan(t){this.enableZoom&&this._handleTouchMoveDolly(t),this.enablePan&&this._handleTouchMovePan(t)}_handleTouchMoveDollyRotate(t){this.enableZoom&&this._handleTouchMoveDolly(t),this.enableRotate&&this._handleTouchMoveRotate(t)}_addPointer(t){this._pointers.push(t.pointerId)}_removePointer(t){delete this._pointerPositions[t.pointerId];for(let e=0;e<this._pointers.length;e++)if(this._pointers[e]==t.pointerId){this._pointers.splice(e,1);return}}_isTrackingPointer(t){for(let e=0;e<this._pointers.length;e++)if(this._pointers[e]==t.pointerId)return!0;return!1}_trackPointer(t){let e=this._pointerPositions[t.pointerId];e===void 0&&(e=new kt,this._pointerPositions[t.pointerId]=e),e.set(t.pageX,t.pageY)}_getSecondPointerPosition(t){const e=t.pointerId===this._pointers[0]?this._pointers[1]:this._pointers[0];return this._pointerPositions[e]}_customWheelEvent(t){const e=t.deltaMode,i={clientX:t.clientX,clientY:t.clientY,deltaY:t.deltaY};switch(e){case 1:i.deltaY*=16;break;case 2:i.deltaY*=100;break}return t.ctrlKey&&!this._controlActive&&(i.deltaY*=10),i}}function ZM(n){this.enabled!==!1&&(this._pointers.length===0&&(this.domElement.setPointerCapture(n.pointerId),this.domElement.addEventListener("pointermove",this._onPointerMove),this.domElement.addEventListener("pointerup",this._onPointerUp)),!this._isTrackingPointer(n)&&(this._addPointer(n),n.pointerType==="touch"?this._onTouchStart(n):this._onMouseDown(n)))}function JM(n){this.enabled!==!1&&(n.pointerType==="touch"?this._onTouchMove(n):this._onMouseMove(n))}function QM(n){switch(this._removePointer(n),this._pointers.length){case 0:this.domElement.releasePointerCapture(n.pointerId),this.domElement.removeEventListener("pointermove",this._onPointerMove),this.domElement.removeEventListener("pointerup",this._onPointerUp),this.dispatchEvent(Yd),this.state=le.NONE;break;case 1:const t=this._pointers[0],e=this._pointerPositions[t];this._onTouchStart({pointerId:t,pageX:e.x,pageY:e.y});break}}function tS(n){let t;switch(n.button){case 0:t=this.mouseButtons.LEFT;break;case 1:t=this.mouseButtons.MIDDLE;break;case 2:t=this.mouseButtons.RIGHT;break;default:t=-1}switch(t){case Cs.DOLLY:if(this.enableZoom===!1)return;this._handleMouseDownDolly(n),this.state=le.DOLLY;break;case Cs.ROTATE:if(n.ctrlKey||n.metaKey||n.shiftKey){if(this.enablePan===!1)return;this._handleMouseDownPan(n),this.state=le.PAN}else{if(this.enableRotate===!1)return;this._handleMouseDownRotate(n),this.state=le.ROTATE}break;case Cs.PAN:if(n.ctrlKey||n.metaKey||n.shiftKey){if(this.enableRotate===!1)return;this._handleMouseDownRotate(n),this.state=le.ROTATE}else{if(this.enablePan===!1)return;this._handleMouseDownPan(n),this.state=le.PAN}break;default:this.state=le.NONE}this.state!==le.NONE&&this.dispatchEvent(Vc)}function eS(n){switch(this.state){case le.ROTATE:if(this.enableRotate===!1)return;this._handleMouseMoveRotate(n);break;case le.DOLLY:if(this.enableZoom===!1)return;this._handleMouseMoveDolly(n);break;case le.PAN:if(this.enablePan===!1)return;this._handleMouseMovePan(n);break}}function nS(n){this.enabled===!1||this.enableZoom===!1||this.state!==le.NONE||(n.preventDefault(),this.dispatchEvent(Vc),this._handleMouseWheel(this._customWheelEvent(n)),this.dispatchEvent(Yd))}function iS(n){this.enabled===!1||this.enablePan===!1||this._handleKeyDown(n)}function sS(n){switch(this._trackPointer(n),this._pointers.length){case 1:switch(this.touches.ONE){case As.ROTATE:if(this.enableRotate===!1)return;this._handleTouchStartRotate(n),this.state=le.TOUCH_ROTATE;break;case As.PAN:if(this.enablePan===!1)return;this._handleTouchStartPan(n),this.state=le.TOUCH_PAN;break;default:this.state=le.NONE}break;case 2:switch(this.touches.TWO){case As.DOLLY_PAN:if(this.enableZoom===!1&&this.enablePan===!1)return;this._handleTouchStartDollyPan(n),this.state=le.TOUCH_DOLLY_PAN;break;case As.DOLLY_ROTATE:if(this.enableZoom===!1&&this.enableRotate===!1)return;this._handleTouchStartDollyRotate(n),this.state=le.TOUCH_DOLLY_ROTATE;break;default:this.state=le.NONE}break;default:this.state=le.NONE}this.state!==le.NONE&&this.dispatchEvent(Vc)}function rS(n){switch(this._trackPointer(n),this.state){case le.TOUCH_ROTATE:if(this.enableRotate===!1)return;this._handleTouchMoveRotate(n),this.update();break;case le.TOUCH_PAN:if(this.enablePan===!1)return;this._handleTouchMovePan(n),this.update();break;case le.TOUCH_DOLLY_PAN:if(this.enableZoom===!1&&this.enablePan===!1)return;this._handleTouchMoveDollyPan(n),this.update();break;case le.TOUCH_DOLLY_ROTATE:if(this.enableZoom===!1&&this.enableRotate===!1)return;this._handleTouchMoveDollyRotate(n),this.update();break;default:this.state=le.NONE}}function oS(n){this.enabled!==!1&&n.preventDefault()}function aS(n){n.key==="Control"&&(this._controlActive=!0,this.domElement.getRootNode().addEventListener("keyup",this._interceptControlUp,{passive:!0,capture:!0}))}function lS(n){n.key==="Control"&&(this._controlActive=!1,this.domElement.getRootNode().removeEventListener("keyup",this._interceptControlUp,{passive:!0,capture:!0}))}const sc={0:{name:"实心",color:"#5c8a4a"},1:{name:"水面",color:"#2f6dd0"},2:{name:"岩浆",color:"#e0483a"},3:{name:"建筑",color:"#c98b3e"},4:{name:"树叶",color:"#3fa34d"},5:{name:"可攀爬",color:"#d8b23c"},6:{name:"水下地面",color:"#2a8f8f"}},cS={key:0,class:"placeholder faint"},uS=bc({__name:"TerrainCanvas",props:{data:{},showTypes:{},yMin:{},yMax:{},topOnly:{type:Boolean},showFails:{type:Boolean},marker:{}},setup(n,{expose:t}){const e=n,i=gr(null);let s=null,r=null,o=null,a=null,l=null,u=null,c=null,h=null,d=0,p="";const g=new Map;for(const C of Object.keys(sc))g.set(Number(C),new $t(sc[Number(C)].color));function v(C){const k=e.data.t[C];if(!e.showTypes[k])return!1;const Y=e.data.y[C];return!(Y<e.yMin||Y>e.yMax)}let m=null;function f(){m=new Map;const C=e.data;if(C)for(let k=0;k<C.count;k++){const Y=C.x[k]+","+C.z[k],H=m.get(Y);(H===void 0||C.y[k]>C.y[H])&&m.set(Y,k)}}function w(C,k,Y,H){var at,dt;const q=(C==null?void 0:C._cap)??((at=C==null?void 0:C.instanceMatrix)==null?void 0:at.count)??0;if(C&&q>=k)return C;C&&(r==null||r.remove(C),C.geometry.dispose(),(dt=C.material)==null||dt.dispose(),C.dispose());const z=new GM(Y(),H(),Math.max(1,k));return z.instanceMatrix.setUsage(Tg),z._cap=Math.max(1,k),z.count=0,r==null||r.add(z),z}function b(C){var k;C.computeBoundingSphere(),(k=C.computeBoundingBox)==null||k.call(C)}function x(){const C=e.data;if(!l)return;if(!C){l.count=0,b(l);return}l=w(l,C.count,()=>new is(1,1,1),()=>new zh({color:16777215}));const k=new ue,Y=new $t;let H=0;for(let q=0;q<C.count;q++){if(!v(q))continue;if(e.topOnly&&m){const bt=C.x[q]+","+C.z[q];if(m.get(bt)!==q)continue}k.makeTranslation(C.x[q]+.5,C.y[q]+.5,C.z[q]+.5),l.setMatrixAt(H,k);const z=g.get(C.t[q])||Y.set("#888888"),at=Math.max(1,C.bbox.y1-C.bbox.y0),dt=.72+.38*((C.y[q]-C.bbox.y0)/at);Y.copy(z).multiplyScalar(dt),l.setColorAt(H,Y),H++}l.count=H,l.instanceMatrix.needsUpdate=!0,l.instanceColor&&(l.instanceColor.needsUpdate=!0),b(l)}function B(){const C=e.data;if(!u)return;if(!C||!e.showFails||!C.fails.length){u.count=0,b(u);return}u=w(u,C.fails.length,()=>new pr(1,12,8),()=>new Yi({color:16729156,transparent:!0,opacity:.65}));const k=new ue,Y=new Di,H=new G,q=new G;let z=0;for(const at of C.fails){const dt=.4+Math.min(2.4,Math.sqrt(at.hits||1)*.5);H.set(dt,dt,dt),q.set(at.x+.5,at.y+.5,at.z+.5),k.compose(q,Y,H),u.setMatrixAt(z++,k)}u.count=z,u.instanceMatrix.needsUpdate=!0,b(u)}let P=!1;function D(){if(!c||!o)return;if(!P){const q=new qe(new pr(.9,16,12),new Yi({color:16777215}));q.name="marker-body",c.add(q);const z=new qe(new kc(.08,.08,14,6),new Yi({color:5809919,transparent:!0,opacity:.85}));z.name="marker-pole",c.add(z);const at=new qe(new Hc(1.4,1.9,24),new Yi({color:5809919,side:In,transparent:!0,opacity:.7}));at.name="marker-ring",at.rotation.x=-Math.PI/2,c.add(at),P=!0}const C=e.marker,k=c.getObjectByName("marker-body"),Y=c.getObjectByName("marker-pole"),H=c.getObjectByName("marker-ring");!k||!Y||!H||(c.visible=!!C,C&&(k.position.set(C.x,C.y+1.6,C.z),Y.position.set(C.x,C.y+8,C.z),H.position.set(C.x,C.y+.06,C.z)))}function N(C){C&&(C.traverse(k=>{var H,q,z;(q=(H=k==null?void 0:k.geometry)==null?void 0:H.dispose)==null||q.call(H);const Y=k==null?void 0:k.material;Array.isArray(Y)?Y.forEach(at=>{var dt;return(dt=at==null?void 0:at.dispose)==null?void 0:dt.call(at)}):(z=Y==null?void 0:Y.dispose)==null||z.call(Y)}),C.clear())}function E(C=!1){const k=e.data;if(!o||!a||!k)return;const Y=`${k.bbox.x0},${k.bbox.x1},${k.bbox.z0},${k.bbox.z1}`;if(!C&&Y===p)return;p=Y;const H=k.bbox,q=(H.x0+H.x1)/2,z=(H.z0+H.z1)/2,at=(H.y0+H.y1)/2,bt=Math.max(H.x1-H.x0,H.z1-H.z0,24)*1.15;o.position.set(q+bt*.55,at+bt*.75,z+bt*.55),o.near=1,o.far=bt*20,o.updateProjectionMatrix(),a.target.set(q,at,z),a.update()}function M(){p="",E(!0)}function L(){d=requestAnimationFrame(L),a==null||a.update(),s&&r&&o&&s.render(r,o)}function J(){const C=i.value;if(!C||!s||!o)return;const k=C.clientWidth||1,Y=C.clientHeight||1;s.setSize(k,Y,!1),o.aspect=k/Y,o.updateProjectionMatrix()}return Ac(()=>{var Y,H,q;const C=i.value;if(!C)return;r=new kM,r.background=new $t("#0d1117"),r.fog=new zc("#0d1117",400,1400),o=new on(55,1,1,4e3),s=new ko({antialias:!0,powerPreference:"high-performance"}),s.setPixelRatio(Math.min(window.devicePixelRatio||1,2)),C.appendChild(s.domElement),a=new $M(o,s.domElement),a.enableDamping=!0,a.dampingFactor=.08,a.maxPolarAngle=Math.PI*.495,a.screenSpacePanning=!1,r.add(new WM(16777215,4478310,1.15));const k=new YM(16777215,.75);k.position.set(1,2,.6),r.add(k),l=w(null,((Y=e.data)==null?void 0:Y.count)||1,()=>new is(1,1,1),()=>new zh({color:16777215})),l.count=0,u=w(null,((q=(H=e.data)==null?void 0:H.fails)==null?void 0:q.length)||1,()=>new pr(1,12,8),()=>new Yi({color:16729156,transparent:!0,opacity:.65})),u.count=0,u.visible=!0,c=new or,r.add(c),J(),h=new ResizeObserver(J),h.observe(C),e.data&&(f(),x(),B(),E()),D(),L()}),Vf(()=>{var C,k;cancelAnimationFrame(d),h==null||h.disconnect(),a==null||a.dispose(),l==null||l.geometry.dispose(),(C=l==null?void 0:l.material)==null||C.dispose(),l==null||l.dispose(),u==null||u.geometry.dispose(),(k=u==null?void 0:u.material)==null||k.dispose(),u==null||u.dispose(),N(c),P=!1,s&&(s.dispose(),s.domElement.remove()),r=null,o=null,a=null,l=null,u=null,c=null,s=null}),bi(()=>e.data,()=>{r&&(f(),x(),B(),E(),D())}),bi(()=>[e.showTypes.join(","),e.yMin,e.yMax,e.topOnly],()=>x()),bi(()=>e.showFails,B),bi(()=>e.marker,D,{deep:!0}),t({resetView:M}),(C,k)=>(nn(),_n("div",{ref_key:"host",ref:i,class:"terrain-host"},[n.data?Wi("",!0):(nn(),_n("div",cS,[...k[0]||(k[0]=[Ot("div",null,"还没有地形数据",-1),Ot("div",{class:"sub"},"点右上角「加载」——按需从 terrain3d.db 拉取，不进 1 Hz 状态流",-1)])]))],512))}}),jd=(n,t)=>{const e=n.__vccOpts||n;for(const[i,s]of t)e[i]=s;return e},hS=jd(uS,[["__scopeId","data-v-8b2d818e"]]),Wn=Object.create(null);Wn.open="0";Wn.close="1";Wn.ping="2";Wn.pong="3";Wn.message="4";Wn.upgrade="5";Wn.noop="6";const bo=Object.create(null);Object.keys(Wn).forEach(n=>{bo[Wn[n]]=n});const rc={type:"error",data:"parser error"},Kd=typeof Blob=="function"||typeof Blob<"u"&&Object.prototype.toString.call(Blob)==="[object BlobConstructor]",$d=typeof ArrayBuffer=="function",Zd=n=>typeof ArrayBuffer.isView=="function"?ArrayBuffer.isView(n):n&&n.buffer instanceof ArrayBuffer,Gc=({type:n,data:t},e,i)=>Kd&&t instanceof Blob?e?i(t):qh(t,i):$d&&(t instanceof ArrayBuffer||Zd(t))?e?i(t):qh(new Blob([t]),i):i(Wn[n]+(t||"")),qh=(n,t)=>{const e=new FileReader;return e.onload=function(){const i=e.result.split(",")[1];t("b"+(i||""))},e.readAsDataURL(n)};function Yh(n){return n instanceof Uint8Array?n:n instanceof ArrayBuffer?new Uint8Array(n):new Uint8Array(n.buffer,n.byteOffset,n.byteLength)}let tl;function fS(n,t){if(Kd&&n.data instanceof Blob)return n.data.arrayBuffer().then(Yh).then(t);if($d&&(n.data instanceof ArrayBuffer||Zd(n.data)))return t(Yh(n.data));Gc(n,!1,e=>{tl||(tl=new TextEncoder),t(tl.encode(e))})}const jh="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",ar=typeof Uint8Array>"u"?[]:new Uint8Array(256);for(let n=0;n<jh.length;n++)ar[jh.charCodeAt(n)]=n;const dS=n=>{let t=n.length*.75,e=n.length,i,s=0,r,o,a,l;n[n.length-1]==="="&&(t--,n[n.length-2]==="="&&t--);const u=new ArrayBuffer(t),c=new Uint8Array(u);for(i=0;i<e;i+=4)r=ar[n.charCodeAt(i)],o=ar[n.charCodeAt(i+1)],a=ar[n.charCodeAt(i+2)],l=ar[n.charCodeAt(i+3)],c[s++]=r<<2|o>>4,c[s++]=(o&15)<<4|a>>2,c[s++]=(a&3)<<6|l&63;return u},pS=typeof ArrayBuffer=="function",Wc=(n,t)=>{if(typeof n!="string")return{type:"message",data:Jd(n,t)};const e=n.charAt(0);return e==="b"?{type:"message",data:mS(n.substring(1),t)}:bo[e]?n.length>1?{type:bo[e],data:n.substring(1)}:{type:bo[e]}:rc},mS=(n,t)=>{if(pS){const e=dS(n);return Jd(e,t)}else return{base64:!0,data:n}},Jd=(n,t)=>{switch(t){case"blob":return n instanceof Blob?n:new Blob([n]);case"arraybuffer":default:return n instanceof ArrayBuffer?n:n.buffer}},Qd="",_S=(n,t)=>{const e=n.length,i=new Array(e);let s=0;n.forEach((r,o)=>{Gc(r,!1,a=>{i[o]=a,++s===e&&t(i.join(Qd))})})},gS=(n,t)=>{const e=n.split(Qd),i=[];for(let s=0;s<e.length;s++){const r=Wc(e[s],t);if(i.push(r),r.type==="error")break}return i};function vS(){return new TransformStream({transform(n,t){fS(n,e=>{const i=e.length;let s;if(i<126)s=new Uint8Array(1),new DataView(s.buffer).setUint8(0,i);else if(i<65536){s=new Uint8Array(3);const r=new DataView(s.buffer);r.setUint8(0,126),r.setUint16(1,i)}else{s=new Uint8Array(9);const r=new DataView(s.buffer);r.setUint8(0,127),r.setBigUint64(1,BigInt(i))}n.data&&typeof n.data!="string"&&(s[0]|=128),t.enqueue(s),t.enqueue(e)})}})}let el;function uo(n){return n.reduce((t,e)=>t+e.length,0)}function ho(n,t){if(n[0].length===t)return n.shift();const e=new Uint8Array(t);let i=0;for(let s=0;s<t;s++)e[s]=n[0][i++],i===n[0].length&&(n.shift(),i=0);return n.length&&i<n[0].length&&(n[0]=n[0].slice(i)),e}function xS(n,t){el||(el=new TextDecoder);const e=[];let i=0,s=-1,r=!1;return new TransformStream({transform(o,a){for(e.push(o);;){if(i===0){if(uo(e)<1)break;const l=ho(e,1);r=(l[0]&128)===128,s=l[0]&127,s<126?i=3:s===126?i=1:i=2}else if(i===1){if(uo(e)<2)break;const l=ho(e,2);s=new DataView(l.buffer,l.byteOffset,l.length).getUint16(0),i=3}else if(i===2){if(uo(e)<8)break;const l=ho(e,8),u=new DataView(l.buffer,l.byteOffset,l.length),c=u.getUint32(0);if(c>Math.pow(2,21)-1){a.enqueue(rc);break}s=c*Math.pow(2,32)+u.getUint32(4),i=3}else{if(uo(e)<s)break;const l=ho(e,s);a.enqueue(Wc(r?l:el.decode(l),t)),i=0}if(s===0||s>n){a.enqueue(rc);break}}}})}const tp=4;function ye(n){if(n)return yS(n)}function yS(n){for(var t in ye.prototype)n[t]=ye.prototype[t];return n}ye.prototype.on=ye.prototype.addEventListener=function(n,t){return this._callbacks=this._callbacks||{},(this._callbacks["$"+n]=this._callbacks["$"+n]||[]).push(t),this};ye.prototype.once=function(n,t){function e(){this.off(n,e),t.apply(this,arguments)}return e.fn=t,this.on(n,e),this};ye.prototype.off=ye.prototype.removeListener=ye.prototype.removeAllListeners=ye.prototype.removeEventListener=function(n,t){if(this._callbacks=this._callbacks||{},arguments.length==0)return this._callbacks={},this;var e=this._callbacks["$"+n];if(!e)return this;if(arguments.length==1)return delete this._callbacks["$"+n],this;for(var i,s=0;s<e.length;s++)if(i=e[s],i===t||i.fn===t){e.splice(s,1);break}return e.length===0&&delete this._callbacks["$"+n],this};ye.prototype.emit=function(n){this._callbacks=this._callbacks||{};for(var t=new Array(arguments.length-1),e=this._callbacks["$"+n],i=1;i<arguments.length;i++)t[i-1]=arguments[i];if(e){e=e.slice(0);for(var i=0,s=e.length;i<s;++i)e[i].apply(this,t)}return this};ye.prototype.emitReserved=ye.prototype.emit;ye.prototype.listeners=function(n){return this._callbacks=this._callbacks||{},this._callbacks["$"+n]||[]};ye.prototype.hasListeners=function(n){return!!this.listeners(n).length};const oa=typeof Promise=="function"&&typeof Promise.resolve=="function"?t=>Promise.resolve().then(t):(t,e)=>e(t,0),an=typeof self<"u"?self:typeof window<"u"?window:Function("return this")(),MS="arraybuffer";function ep(n,...t){return t.reduce((e,i)=>(n.hasOwnProperty(i)&&(e[i]=n[i]),e),{})}const SS=an.setTimeout,ES=an.clearTimeout;function aa(n,t){t.useNativeTimers?(n.setTimeoutFn=SS.bind(an),n.clearTimeoutFn=ES.bind(an)):(n.setTimeoutFn=an.setTimeout.bind(an),n.clearTimeoutFn=an.clearTimeout.bind(an))}const bS=1.33;function TS(n){return typeof n=="string"?AS(n):Math.ceil((n.byteLength||n.size)*bS)}function AS(n){let t=0,e=0;for(let i=0,s=n.length;i<s;i++)t=n.charCodeAt(i),t<128?e+=1:t<2048?e+=2:t<55296||t>=57344?e+=3:(i++,e+=4);return e}function np(){return Date.now().toString(36).substring(3)+Math.random().toString(36).substring(2,5)}function wS(n){let t="";for(let e in n)n.hasOwnProperty(e)&&(t.length&&(t+="&"),t+=encodeURIComponent(e)+"="+encodeURIComponent(n[e]));return t}function RS(n){let t={},e=n.split("&");for(let i=0,s=e.length;i<s;i++){let r=e[i].split("=");t[decodeURIComponent(r[0])]=decodeURIComponent(r[1])}return t}class CS extends Error{constructor(t,e,i){super(t),this.description=e,this.context=i,this.type="TransportError"}}class Xc extends ye{constructor(t){super(),this.writable=!1,aa(this,t),this.opts=t,this.query=t.query,this.socket=t.socket,this.supportsBinary=!t.forceBase64}onError(t,e,i){return super.emitReserved("error",new CS(t,e,i)),this}open(){return this.readyState="opening",this.doOpen(),this}close(){return(this.readyState==="opening"||this.readyState==="open")&&(this.doClose(),this.onClose()),this}send(t){this.readyState==="open"&&this.write(t)}onOpen(){this.readyState="open",this.writable=!0,super.emitReserved("open")}onData(t){const e=Wc(t,this.socket.binaryType);this.onPacket(e)}onPacket(t){super.emitReserved("packet",t)}onClose(t){this.readyState="closed",super.emitReserved("close",t)}pause(t){}createUri(t,e={}){return t+"://"+this._hostname()+this._port()+this.opts.path+this._query(e)}_hostname(){const t=this.opts.hostname;return t.indexOf(":")===-1?t:"["+t+"]"}_port(){return this.opts.port&&(this.opts.secure&&Number(this.opts.port)!==443||!this.opts.secure&&Number(this.opts.port)!==80)?":"+this.opts.port:""}_query(t){const e=wS(t);return e.length?"?"+e:""}}class PS extends Xc{constructor(){super(...arguments),this._polling=!1}get name(){return"polling"}doOpen(){this._poll()}pause(t){this.readyState="pausing";const e=()=>{this.readyState="paused",t()};if(this._polling||!this.writable){let i=0;this._polling&&(i++,this.once("pollComplete",function(){--i||e()})),this.writable||(i++,this.once("drain",function(){--i||e()}))}else e()}_poll(){this._polling=!0,this.doPoll(),this.emitReserved("poll")}onData(t){const e=i=>{if(this.readyState==="opening"&&i.type==="open"&&this.onOpen(),i.type==="close")return this.onClose({description:"transport closed by the server"}),!1;this.onPacket(i)};gS(t,this.socket.binaryType).forEach(e),this.readyState!=="closed"&&(this._polling=!1,this.emitReserved("pollComplete"),this.readyState==="open"&&this._poll())}doClose(){const t=()=>{this.write([{type:"close"}])};this.readyState==="open"?t():this.once("open",t)}write(t){this.writable=!1,_S(t,e=>{this.doWrite(e,()=>{this.writable=!0,this.emitReserved("drain")})})}uri(){const t=this.opts.secure?"https":"http",e=this.query||{};return this.opts.timestampRequests!==!1&&(e[this.opts.timestampParam]=np()),!this.supportsBinary&&!e.sid&&(e.b64=1),this.createUri(t,e)}}let ip=!1;try{ip=typeof XMLHttpRequest<"u"&&"withCredentials"in new XMLHttpRequest}catch{}const DS=ip;function LS(){}class IS extends PS{constructor(t){if(super(t),typeof location<"u"){const e=location.protocol==="https:";let i=location.port;i||(i=e?"443":"80"),this.xd=typeof location<"u"&&t.hostname!==location.hostname||i!==t.port}}doWrite(t,e){const i=this.request({method:"POST",data:t});i.on("success",e),i.on("error",(s,r)=>{this.onError("xhr post error",s,r)})}doPoll(){const t=this.request();t.on("data",this.onData.bind(this)),t.on("error",(e,i)=>{this.onError("xhr poll error",e,i)}),this.pollXhr=t}}class Bn extends ye{constructor(t,e,i){super(),this.createRequest=t,aa(this,i),this._opts=i,this._method=i.method||"GET",this._uri=e,this._data=i.data!==void 0?i.data:null,this._create()}_create(){var t;const e=ep(this._opts,"agent","pfx","key","passphrase","cert","ca","ciphers","rejectUnauthorized","autoUnref");e.xdomain=!!this._opts.xd;const i=this._xhr=this.createRequest(e);try{i.open(this._method,this._uri,!0);try{if(this._opts.extraHeaders){i.setDisableHeaderCheck&&i.setDisableHeaderCheck(!0);for(let s in this._opts.extraHeaders)this._opts.extraHeaders.hasOwnProperty(s)&&i.setRequestHeader(s,this._opts.extraHeaders[s])}}catch{}if(this._method==="POST")try{i.setRequestHeader("Content-type","text/plain;charset=UTF-8")}catch{}try{i.setRequestHeader("Accept","*/*")}catch{}(t=this._opts.cookieJar)===null||t===void 0||t.addCookies(i),"withCredentials"in i&&(i.withCredentials=this._opts.withCredentials),this._opts.requestTimeout&&(i.timeout=this._opts.requestTimeout),i.onreadystatechange=()=>{var s;i.readyState===3&&((s=this._opts.cookieJar)===null||s===void 0||s.parseCookies(i.getResponseHeader("set-cookie"))),i.readyState===4&&(i.status===200||i.status===1223?this._onLoad():this.setTimeoutFn(()=>{this._onError(typeof i.status=="number"?i.status:0)},0))},i.send(this._data)}catch(s){this.setTimeoutFn(()=>{this._onError(s)},0);return}typeof document<"u"&&(this._index=Bn.requestsCount++,Bn.requests[this._index]=this)}_onError(t){this.emitReserved("error",t,this._xhr),this._cleanup(!0)}_cleanup(t){if(!(typeof this._xhr>"u"||this._xhr===null)){if(this._xhr.onreadystatechange=LS,t)try{this._xhr.abort()}catch{}typeof document<"u"&&delete Bn.requests[this._index],this._xhr=null}}_onLoad(){const t=this._xhr.responseText;t!==null&&(this.emitReserved("data",t),this.emitReserved("success"),this._cleanup())}abort(){this._cleanup()}}Bn.requestsCount=0;Bn.requests={};if(typeof document<"u"){if(typeof attachEvent=="function")attachEvent("onunload",Kh);else if(typeof addEventListener=="function"){const n="onpagehide"in an?"pagehide":"unload";addEventListener(n,Kh,!1)}}function Kh(){for(let n in Bn.requests)Bn.requests.hasOwnProperty(n)&&Bn.requests[n].abort()}const US=(function(){const n=sp({xdomain:!1});return n&&n.responseType!==null})();class NS extends IS{constructor(t){super(t);const e=t&&t.forceBase64;this.supportsBinary=US&&!e}request(t={}){return Object.assign(t,{xd:this.xd},this.opts),new Bn(sp,this.uri(),t)}}function sp(n){const t=n.xdomain;try{if(typeof XMLHttpRequest<"u"&&(!t||DS))return new XMLHttpRequest}catch{}if(!t)try{return new an[["Active"].concat("Object").join("X")]("Microsoft.XMLHTTP")}catch{}}const rp=typeof navigator<"u"&&typeof navigator.product=="string"&&navigator.product.toLowerCase()==="reactnative";class OS extends Xc{get name(){return"websocket"}doOpen(){const t=this.uri(),e=this.opts.protocols,i=rp?{}:ep(this.opts,"agent","perMessageDeflate","pfx","key","passphrase","cert","ca","ciphers","rejectUnauthorized","localAddress","protocolVersion","origin","maxPayload","family","checkServerIdentity");this.opts.extraHeaders&&(i.headers=this.opts.extraHeaders);try{this.ws=this.createSocket(t,e,i)}catch(s){return this.emitReserved("error",s)}this.ws.binaryType=this.socket.binaryType,this.addEventListeners()}addEventListeners(){this.ws.onopen=()=>{this.opts.autoUnref&&this.ws._socket.unref(),this.onOpen()},this.ws.onclose=t=>this.onClose({description:"websocket connection closed",context:t}),this.ws.onmessage=t=>this.onData(t.data),this.ws.onerror=t=>this.onError("websocket error",t)}write(t){this.writable=!1;for(let e=0;e<t.length;e++){const i=t[e],s=e===t.length-1;Gc(i,this.supportsBinary,r=>{try{this.doWrite(i,r)}catch{}s&&oa(()=>{this.writable=!0,this.emitReserved("drain")},this.setTimeoutFn)})}}doClose(){typeof this.ws<"u"&&(this.ws.onerror=()=>{},this.ws.close(),this.ws=null)}uri(){const t=this.opts.secure?"wss":"ws",e=this.query||{};return this.opts.timestampRequests&&(e[this.opts.timestampParam]=np()),this.supportsBinary||(e.b64=1),this.createUri(t,e)}}const nl=an.WebSocket||an.MozWebSocket;class FS extends OS{createSocket(t,e,i){return rp?new nl(t,e,i):e?new nl(t,e):new nl(t)}doWrite(t,e){this.ws.send(e)}}class BS extends Xc{get name(){return"webtransport"}doOpen(){try{this._transport=new WebTransport(this.createUri("https"),this.opts.transportOptions[this.name])}catch(t){return this.emitReserved("error",t)}this._transport.closed.then(()=>{this.onClose()}).catch(t=>{this.onError("webtransport error",t)}),this._transport.ready.then(()=>{this._transport.createBidirectionalStream().then(t=>{const e=xS(Number.MAX_SAFE_INTEGER,this.socket.binaryType),i=t.readable.pipeThrough(e).getReader(),s=vS();s.readable.pipeTo(t.writable),this._writer=s.writable.getWriter();const r=()=>{i.read().then(({done:a,value:l})=>{a||(this.onPacket(l),r())}).catch(a=>{})};r();const o={type:"open"};this.query.sid&&(o.data=`{"sid":"${this.query.sid}"}`),this._writer.write(o).then(()=>this.onOpen())})})}write(t){this.writable=!1;for(let e=0;e<t.length;e++){const i=t[e],s=e===t.length-1;this._writer.write(i).then(()=>{s&&oa(()=>{this.writable=!0,this.emitReserved("drain")},this.setTimeoutFn)})}}doClose(){var t;(t=this._transport)===null||t===void 0||t.close()}}const zS={websocket:FS,webtransport:BS,polling:NS},kS=/^(?:(?![^:@\/?#]+:[^:@\/]*@)(http|https|ws|wss):\/\/)?((?:(([^:@\/?#]*)(?::([^:@\/?#]*))?)?@)?((?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}|[^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/,HS=["source","protocol","authority","userInfo","user","password","host","port","relative","path","directory","file","query","anchor"];function oc(n){if(n.length>8e3)throw"URI too long";const t=n,e=n.indexOf("["),i=n.indexOf("]");e!=-1&&i!=-1&&(n=n.substring(0,e)+n.substring(e,i).replace(/:/g,";")+n.substring(i,n.length));let s=kS.exec(n||""),r={},o=14;for(;o--;)r[HS[o]]=s[o]||"";return e!=-1&&i!=-1&&(r.source=t,r.host=r.host.substring(1,r.host.length-1).replace(/;/g,":"),r.authority=r.authority.replace("[","").replace("]","").replace(/;/g,":"),r.ipv6uri=!0),r.pathNames=VS(r,r.path),r.queryKey=GS(r,r.query),r}function VS(n,t){const e=/\/{2,9}/g,i=t.replace(e,"/").split("/");return(t.slice(0,1)=="/"||t.length===0)&&i.splice(0,1),t.slice(-1)=="/"&&i.splice(i.length-1,1),i}function GS(n,t){const e={};return t.replace(/(?:^|&)([^&=]*)=?([^&]*)/g,function(i,s,r){s&&(e[s]=r)}),e}const ac=typeof addEventListener=="function"&&typeof removeEventListener=="function",To=[];ac&&addEventListener("offline",()=>{To.forEach(n=>n())},!1);let op=class Ts extends ye{constructor(t,e={}){var i,s;if(super(),this.binaryType=MS,this.writeBuffer=[],this._prevBufferLen=0,this._upgrades=[],this._pingInterval=-1,this._pingTimeout=-1,this._maxPayload=-1,this._pingTimeoutTime=1/0,t&&typeof t=="object"&&(e=t,t=null),t){const r=oc(t);e.hostname=r.host,e.secure=r.protocol==="https"||r.protocol==="wss",e.port=r.port,r.query&&(e.query=r.query)}else e.host&&(e.hostname=oc(e.host).host);if(aa(this,e),this.secure=e.secure!=null?e.secure:typeof location<"u"&&location.protocol==="https:",e.hostname&&!e.port&&(e.port=this.secure?"443":"80"),this.hostname=e.hostname||(typeof location<"u"?location.hostname:"localhost"),this.port=e.port||(typeof location<"u"&&location.port?location.port:this.secure?"443":"80"),e.transportImplementations&&e.transports)throw new Error("specifying both 'transportImplementations' and 'transports' options is not supported");e.transportImplementations||!((i=e.transports)===null||i===void 0)&&i.length&&typeof e.transports[0]=="function"?(this.transports=[],this._transportsByName=Object.create(null),((s=e.transportImplementations)!==null&&s!==void 0?s:e.transports).forEach(r=>{const o=r.prototype.name;this.transports.push(o),this._transportsByName[o]=r})):(this.transports=e.transports?[...e.transports]:["polling","websocket","webtransport"],this._transportsByName=zS),this.opts=Object.assign({path:"/engine.io",agent:!1,withCredentials:!1,upgrade:!0,timestampParam:"t",rememberUpgrade:!1,addTrailingSlash:!0,rejectUnauthorized:!0,perMessageDeflate:{threshold:1024},transportOptions:{},closeOnBeforeunload:!1},e),this.opts.path=this.opts.path.replace(/\/$/,"")+(this.opts.addTrailingSlash?"/":""),typeof this.opts.query=="string"&&(this.opts.query=RS(this.opts.query)),ac&&(this.opts.closeOnBeforeunload&&(this._beforeunloadEventListener=()=>{this.transport&&(this.transport.removeAllListeners(),this.transport.close())},addEventListener("beforeunload",this._beforeunloadEventListener,!1)),this.hostname!=="localhost"&&(this._offlineEventListener=()=>{this._onClose("transport close",{description:"network connection lost"})},To.push(this._offlineEventListener))),this.opts.withCredentials&&(this._cookieJar=void 0),this._open()}createTransport(t){const e=Object.assign({},this.opts.query);e.EIO=tp,e.transport=t,this.id&&(e.sid=this.id);const i=Object.assign({},this.opts,{query:e,socket:this,hostname:this.hostname,secure:this.secure,port:this.port},this.opts.transportOptions[t]);return new this._transportsByName[t](i)}_open(){if(this.transports.length===0){this.setTimeoutFn(()=>{this.emitReserved("error","No transports available")},0);return}const t=this.opts.rememberUpgrade&&Ts.priorWebsocketSuccess&&this.transports.indexOf("websocket")!==-1?"websocket":this.transports[0];this.readyState="opening";const e=this.createTransport(t);e.open(),this.setTransport(e)}setTransport(t){this.transport&&this.transport.removeAllListeners(),this.transport=t,t.on("drain",this._onDrain.bind(this)).on("packet",this._onPacket.bind(this)).on("error",this._onError.bind(this)).on("close",e=>this._onClose("transport close",e))}_probe(t){let e=this.createTransport(t),i=!1;Ts.priorWebsocketSuccess=!1;const s=()=>{i||(e.send([{type:"ping",data:"probe"}]),e.once("packet",h=>{if(!i)if(h.type==="pong"&&h.data==="probe"){if(this.upgrading=!0,this.emitReserved("upgrading",e),!e)return;Ts.priorWebsocketSuccess=e.name==="websocket",this.transport.pause(()=>{i||this.readyState!=="closed"&&(c(),this.setTransport(e),e.send([{type:"upgrade"}]),this.emitReserved("upgrade",e),e=null,this.upgrading=!1,this.flush())})}else{const d=new Error("probe error");d.transport=e.name,this.emitReserved("upgradeError",d)}}))};function r(){i||(i=!0,c(),e.close(),e=null)}const o=h=>{const d=new Error("probe error: "+h);d.transport=e.name,r(),this.emitReserved("upgradeError",d)};function a(){o("transport closed")}function l(){o("socket closed")}function u(h){e&&h.name!==e.name&&r()}const c=()=>{e.removeListener("open",s),e.removeListener("error",o),e.removeListener("close",a),this.off("close",l),this.off("upgrading",u)};e.once("open",s),e.once("error",o),e.once("close",a),this.once("close",l),this.once("upgrading",u),this._upgrades.indexOf("webtransport")!==-1&&t!=="webtransport"?this.setTimeoutFn(()=>{i||e.open()},200):e.open()}onOpen(){if(this.readyState="open",Ts.priorWebsocketSuccess=this.transport.name==="websocket",this.emitReserved("open"),this.flush(),this.readyState==="open"&&this.opts.upgrade)for(let t=0;t<this._upgrades.length;t++)this._probe(this._upgrades[t])}_onPacket(t){if(this.readyState==="opening"||this.readyState==="open"||this.readyState==="closing")switch(this.emitReserved("packet",t),this.emitReserved("heartbeat"),t.type){case"open":this.onHandshake(JSON.parse(t.data));break;case"ping":this._sendPacket("pong"),this.emitReserved("ping"),this.emitReserved("pong"),this._resetPingTimeout();break;case"error":const e=new Error("server error");e.code=t.data,this._onError(e);break;case"message":this.emitReserved("data",t.data),this.emitReserved("message",t.data);break}}onHandshake(t){this.emitReserved("handshake",t),this.id=t.sid,this.transport.query.sid=t.sid,this._upgrades=this._filterUpgrades(t.upgrades),this._pingInterval=t.pingInterval,this._pingTimeout=t.pingTimeout,this._maxPayload=t.maxPayload,this.onOpen(),this.readyState!=="closed"&&this._resetPingTimeout()}_resetPingTimeout(){this.clearTimeoutFn(this._pingTimeoutTimer);const t=this._pingInterval+this._pingTimeout;this._pingTimeoutTime=Date.now()+t,this._pingTimeoutTimer=this.setTimeoutFn(()=>{this._onClose("ping timeout")},t),this.opts.autoUnref&&this._pingTimeoutTimer.unref()}_onDrain(){this.writeBuffer.splice(0,this._prevBufferLen),this._prevBufferLen=0,this.writeBuffer.length===0?this.emitReserved("drain"):this.flush()}flush(){if(this.readyState!=="closed"&&this.transport.writable&&!this.upgrading&&this.writeBuffer.length){const t=this._getWritablePackets();this.transport.send(t),this._prevBufferLen=t.length,this.emitReserved("flush")}}_getWritablePackets(){if(!(this._maxPayload&&this.transport.name==="polling"&&this.writeBuffer.length>1))return this.writeBuffer;let e=1;for(let i=0;i<this.writeBuffer.length;i++){const s=this.writeBuffer[i].data;if(s&&(e+=TS(s)),i>0&&e>this._maxPayload)return this.writeBuffer.slice(0,i);e+=2}return this.writeBuffer}_hasPingExpired(){if(!this._pingTimeoutTime)return!0;const t=Date.now()>this._pingTimeoutTime;return t&&(this._pingTimeoutTime=0,oa(()=>{this._onClose("ping timeout")},this.setTimeoutFn)),t}write(t,e,i){return this._sendPacket("message",t,e,i),this}send(t,e,i){return this._sendPacket("message",t,e,i),this}_sendPacket(t,e,i,s){if(typeof e=="function"&&(s=e,e=void 0),typeof i=="function"&&(s=i,i=null),this.readyState==="closing"||this.readyState==="closed")return;i=i||{},i.compress=i.compress!==!1;const r={type:t,data:e,options:i};this.emitReserved("packetCreate",r),this.writeBuffer.push(r),s&&this.once("flush",s),this.flush()}close(){const t=()=>{this._onClose("forced close"),this.transport.close()},e=()=>{this.off("upgrade",e),this.off("upgradeError",e),t()},i=()=>{this.once("upgrade",e),this.once("upgradeError",e)};return(this.readyState==="opening"||this.readyState==="open")&&(this.readyState="closing",this.writeBuffer.length?this.once("drain",()=>{this.upgrading?i():t()}):this.upgrading?i():t()),this}_onError(t){if(Ts.priorWebsocketSuccess=!1,this.opts.tryAllTransports&&this.transports.length>1&&this.readyState==="opening")return this.transports.shift(),this._open();this.emitReserved("error",t),this._onClose("transport error",t)}_onClose(t,e){if(this.readyState==="opening"||this.readyState==="open"||this.readyState==="closing"){if(this.clearTimeoutFn(this._pingTimeoutTimer),this.transport.removeAllListeners("close"),this.transport.close(),this.transport.removeAllListeners(),ac&&(this._beforeunloadEventListener&&removeEventListener("beforeunload",this._beforeunloadEventListener,!1),this._offlineEventListener)){const i=To.indexOf(this._offlineEventListener);i!==-1&&To.splice(i,1)}this.readyState="closed",this.id=null,this.emitReserved("close",t,e),this.writeBuffer=[],this._prevBufferLen=0}}_filterUpgrades(t){const e=[];for(let i=0;i<t.length;i++)~this.transports.indexOf(t[i])&&e.push(t[i]);return e}};op.protocol=tp;function WS(n,t="",e){let i=n;e=e||typeof location<"u"&&location,n==null&&(n=e.protocol+"//"+e.host),typeof n=="string"&&(n.charAt(0)==="/"&&(n.charAt(1)==="/"?n=e.protocol+n:n=e.host+n),/^(https?|wss?):\/\//.test(n)||(typeof e<"u"?n=e.protocol+"//"+n:n="https://"+n),i=oc(n)),i.port||(/^(http|ws)$/.test(i.protocol)?i.port="80":/^(http|ws)s$/.test(i.protocol)&&(i.port="443")),i.path=i.path||"/";const r=i.host.indexOf(":")!==-1?"["+i.host+"]":i.host;return i.id=i.protocol+"://"+r+":"+i.port+t,i.href=i.protocol+"://"+r+(e&&e.port===i.port?"":":"+i.port),i}const XS=typeof ArrayBuffer=="function",qS=n=>typeof ArrayBuffer.isView=="function"?ArrayBuffer.isView(n):n.buffer instanceof ArrayBuffer,ap=Object.prototype.toString,YS=typeof Blob=="function"||typeof Blob<"u"&&ap.call(Blob)==="[object BlobConstructor]",jS=typeof File=="function"||typeof File<"u"&&ap.call(File)==="[object FileConstructor]";function qc(n){return XS&&(n instanceof ArrayBuffer||qS(n))||YS&&n instanceof Blob||jS&&n instanceof File}function Ao(n,t){if(!n||typeof n!="object")return!1;if(Array.isArray(n)){for(let e=0,i=n.length;e<i;e++)if(Ao(n[e]))return!0;return!1}if(qc(n))return!0;if(n.toJSON&&typeof n.toJSON=="function"&&arguments.length===1)return Ao(n.toJSON(),!0);for(const e in n)if(Object.prototype.hasOwnProperty.call(n,e)&&Ao(n[e]))return!0;return!1}function KS(n){const t=[],e=n.data,i=n;return i.data=wo(e,t),i.attachments=t.length,{packet:i,buffers:t}}function wo(n,t,e){if(!n)return n;if(qc(n)){const i={_placeholder:!0,num:t.length};return t.push(n),i}else if(Array.isArray(n)){const i=new Array(n.length);for(let s=0;s<n.length;s++)i[s]=wo(n[s],t);return i}else if(typeof n=="object"&&!(n instanceof Date)){if(n.toJSON&&typeof n.toJSON=="function"&&!e)return wo(n.toJSON(),t,!0);const i={};for(const s in n)Object.prototype.hasOwnProperty.call(n,s)&&(i[s]=wo(n[s],t));return i}return n}function $S(n,t){return n.data=lc(n.data,t),delete n.attachments,n}function lc(n,t){if(!n)return n;if(n&&n._placeholder===!0){if(typeof n.num=="number"&&n.num>=0&&n.num<t.length)return t[n.num];throw new Error("illegal attachments")}else if(Array.isArray(n))for(let e=0;e<n.length;e++)n[e]=lc(n[e],t);else if(typeof n=="object")for(const e in n)Object.prototype.hasOwnProperty.call(n,e)&&(n[e]=lc(n[e],t));return n}const ZS=["connect","connect_error","disconnect","disconnecting","newListener","removeListener"];var Zt;(function(n){n[n.CONNECT=0]="CONNECT",n[n.DISCONNECT=1]="DISCONNECT",n[n.EVENT=2]="EVENT",n[n.ACK=3]="ACK",n[n.CONNECT_ERROR=4]="CONNECT_ERROR",n[n.BINARY_EVENT=5]="BINARY_EVENT",n[n.BINARY_ACK=6]="BINARY_ACK"})(Zt||(Zt={}));class JS{constructor(t){this.replacer=t}encode(t){return(t.type===Zt.EVENT||t.type===Zt.ACK)&&Ao(t)?this.encodeAsBinary({type:t.type===Zt.EVENT?Zt.BINARY_EVENT:Zt.BINARY_ACK,nsp:t.nsp,data:t.data,id:t.id}):[this.encodeAsString(t)]}encodeAsString(t){let e=""+t.type;return(t.type===Zt.BINARY_EVENT||t.type===Zt.BINARY_ACK)&&(e+=t.attachments+"-"),t.nsp&&t.nsp!=="/"&&(e+=t.nsp+","),t.id!=null&&(e+=t.id),t.data!=null&&(e+=JSON.stringify(t.data,this.replacer)),e}encodeAsBinary(t){const e=KS(t),i=this.encodeAsString(e.packet),s=e.buffers;return s.unshift(i),s}}class Yc extends ye{constructor(t){super(),this.opts=Object.assign({reviver:void 0,maxAttachments:10},typeof t=="function"?{reviver:t}:t)}add(t){let e;if(typeof t=="string"){if(this.reconstructor)throw new Error("got plaintext data when reconstructing a packet");e=this.decodeString(t);const i=e.type===Zt.BINARY_EVENT;i||e.type===Zt.BINARY_ACK?(e.type=i?Zt.EVENT:Zt.ACK,this.reconstructor=new QS(e)):super.emitReserved("decoded",e)}else if(qc(t)||t.base64)if(this.reconstructor)e=this.reconstructor.takeBinaryData(t),e&&(this.reconstructor=null,super.emitReserved("decoded",e));else throw new Error("got binary data when not reconstructing a packet");else throw new Error("Unknown type: "+t)}decodeString(t){let e=0;const i={type:Number(t.charAt(0))};if(Zt[i.type]===void 0)throw new Error("unknown packet type "+i.type);if(i.type===Zt.BINARY_EVENT||i.type===Zt.BINARY_ACK){const r=e+1;for(;t.charAt(++e)!=="-"&&e!=t.length;);const o=t.substring(r,e);if(o!=Number(o)||t.charAt(e)!=="-")throw new Error("Illegal attachments");const a=Number(o);if(!tE(a)||a<1)throw new Error("Illegal attachments");if(a>this.opts.maxAttachments)throw new Error("too many attachments");i.attachments=a}if(t.charAt(e+1)==="/"){const r=e+1;for(;++e&&!(t.charAt(e)===","||e===t.length););i.nsp=t.substring(r,e)}else i.nsp="/";const s=t.charAt(e+1);if(s!==""&&Number(s)==s){const r=e+1;for(;++e;){const o=t.charAt(e);if(o==null||Number(o)!=o){--e;break}if(e===t.length)break}i.id=Number(t.substring(r,e+1))}if(t.charAt(++e)){const r=this.tryParse(t.substr(e));if(Yc.isPayloadValid(i.type,r))i.data=r;else throw new Error("invalid payload")}return i}tryParse(t){try{return JSON.parse(t,this.opts.reviver)}catch{return!1}}static isPayloadValid(t,e){switch(t){case Zt.CONNECT:return $h(e);case Zt.DISCONNECT:return e===void 0;case Zt.CONNECT_ERROR:return typeof e=="string"||$h(e);case Zt.EVENT:case Zt.BINARY_EVENT:return Array.isArray(e)&&(typeof e[0]=="number"||typeof e[0]=="string"&&ZS.indexOf(e[0])===-1);case Zt.ACK:case Zt.BINARY_ACK:return Array.isArray(e)}}destroy(){this.reconstructor&&(this.reconstructor.finishedReconstruction(),this.reconstructor=null)}}class QS{constructor(t){this.packet=t,this.buffers=[],this.reconPack=t}takeBinaryData(t){if(this.buffers.push(t),this.buffers.length===this.reconPack.attachments){const e=$S(this.reconPack,this.buffers);return this.finishedReconstruction(),e}return null}finishedReconstruction(){this.reconPack=null,this.buffers=[]}}const tE=Number.isInteger||function(n){return typeof n=="number"&&isFinite(n)&&Math.floor(n)===n};function $h(n){return Object.prototype.toString.call(n)==="[object Object]"}const eE=Object.freeze(Object.defineProperty({__proto__:null,Decoder:Yc,Encoder:JS,get PacketType(){return Zt}},Symbol.toStringTag,{value:"Module"}));function vn(n,t,e){return n.on(t,e),function(){n.off(t,e)}}const nE=Object.freeze({connect:1,connect_error:1,disconnect:1,disconnecting:1,newListener:1,removeListener:1});class lp extends ye{constructor(t,e,i){super(),this.connected=!1,this.recovered=!1,this.receiveBuffer=[],this.sendBuffer=[],this._queue=[],this._queueSeq=0,this.ids=0,this.acks={},this.flags={},this.io=t,this.nsp=e,i&&i.auth&&(this.auth=i.auth),this._opts=Object.assign({},i),this.io._autoConnect&&this.open()}get disconnected(){return!this.connected}subEvents(){if(this.subs)return;const t=this.io;this.subs=[vn(t,"open",this.onopen.bind(this)),vn(t,"packet",this.onpacket.bind(this)),vn(t,"error",this.onerror.bind(this)),vn(t,"close",this.onclose.bind(this))]}get active(){return!!this.subs}connect(){return this.connected?this:(this.subEvents(),this.io._reconnecting||this.io.open(),this.io._readyState==="open"&&this.onopen(),this)}open(){return this.connect()}send(...t){return t.unshift("message"),this.emit.apply(this,t),this}emit(t,...e){var i,s,r;if(nE.hasOwnProperty(t))throw new Error('"'+t.toString()+'" is a reserved event name');if(e.unshift(t),this._opts.retries&&!this.flags.fromQueue&&!this.flags.volatile)return this._addToQueue(e),this;const o={type:Zt.EVENT,data:e};if(o.options={},o.options.compress=this.flags.compress!==!1,typeof e[e.length-1]=="function"){const c=this.ids++,h=e.pop();this._registerAckCallback(c,h),o.id=c}const a=(s=(i=this.io.engine)===null||i===void 0?void 0:i.transport)===null||s===void 0?void 0:s.writable,l=this.connected&&!(!((r=this.io.engine)===null||r===void 0)&&r._hasPingExpired());return this.flags.volatile&&!a||(l?(this.notifyOutgoingListeners(o),this.packet(o)):this.sendBuffer.push(o)),this.flags={},this}_registerAckCallback(t,e){var i;const s=(i=this.flags.timeout)!==null&&i!==void 0?i:this._opts.ackTimeout;if(s===void 0){this.acks[t]=e;return}const r=this.io.setTimeoutFn(()=>{delete this.acks[t];for(let a=0;a<this.sendBuffer.length;a++)this.sendBuffer[a].id===t&&this.sendBuffer.splice(a,1);e.call(this,new Error("operation has timed out"))},s),o=(...a)=>{this.io.clearTimeoutFn(r),e.apply(this,a)};o.withError=!0,this.acks[t]=o}emitWithAck(t,...e){return new Promise((i,s)=>{const r=(o,a)=>o?s(o):i(a);r.withError=!0,e.push(r),this.emit(t,...e)})}_addToQueue(t){let e;typeof t[t.length-1]=="function"&&(e=t.pop());const i={id:this._queueSeq++,tryCount:0,pending:!1,args:t,flags:Object.assign({fromQueue:!0},this.flags)};t.push((s,...r)=>(this._queue[0],s!==null?i.tryCount>this._opts.retries&&(this._queue.shift(),e&&e(s)):(this._queue.shift(),e&&e(null,...r)),i.pending=!1,this._drainQueue())),this._queue.push(i),this._drainQueue()}_drainQueue(t=!1){if(!this.connected||this._queue.length===0)return;const e=this._queue[0];e.pending&&!t||(e.pending=!0,e.tryCount++,this.flags=e.flags,this.emit.apply(this,e.args))}packet(t){t.nsp=this.nsp,this.io._packet(t)}onopen(){typeof this.auth=="function"?this.auth(t=>{this._sendConnectPacket(t)}):this._sendConnectPacket(this.auth)}_sendConnectPacket(t){this.packet({type:Zt.CONNECT,data:this._pid?Object.assign({pid:this._pid,offset:this._lastOffset},t):t})}onerror(t){this.connected||this.emitReserved("connect_error",t)}onclose(t,e){this.connected=!1,delete this.id,this.emitReserved("disconnect",t,e),this._clearAcks()}_clearAcks(){Object.keys(this.acks).forEach(t=>{if(!this.sendBuffer.some(i=>String(i.id)===t)){const i=this.acks[t];delete this.acks[t],i.withError&&i.call(this,new Error("socket has been disconnected"))}})}onpacket(t){if(t.nsp===this.nsp)switch(t.type){case Zt.CONNECT:t.data&&t.data.sid?this.onconnect(t.data.sid,t.data.pid):this.emitReserved("connect_error",new Error("It seems you are trying to reach a Socket.IO server in v2.x with a v3.x client, but they are not compatible (more information here: https://socket.io/docs/v3/migrating-from-2-x-to-3-0/)"));break;case Zt.EVENT:case Zt.BINARY_EVENT:this.onevent(t);break;case Zt.ACK:case Zt.BINARY_ACK:this.onack(t);break;case Zt.DISCONNECT:this.ondisconnect();break;case Zt.CONNECT_ERROR:this.destroy();const i=new Error(t.data.message);i.data=t.data.data,this.emitReserved("connect_error",i);break}}onevent(t){const e=t.data||[];t.id!=null&&e.push(this.ack(t.id)),this.connected?this.emitEvent(e):this.receiveBuffer.push(Object.freeze(e))}emitEvent(t){if(this._anyListeners&&this._anyListeners.length){const e=this._anyListeners.slice();for(const i of e)i.apply(this,t)}super.emit.apply(this,t),this._pid&&t.length&&typeof t[t.length-1]=="string"&&(this._lastOffset=t[t.length-1])}ack(t){const e=this;let i=!1;return function(...s){i||(i=!0,e.packet({type:Zt.ACK,id:t,data:s}))}}onack(t){const e=this.acks[t.id];typeof e=="function"&&(delete this.acks[t.id],e.withError&&t.data.unshift(null),e.apply(this,t.data))}onconnect(t,e){this.id=t,this.recovered=e&&this._pid===e,this._pid=e,this.connected=!0,this.emitBuffered(),this._drainQueue(!0),this.emitReserved("connect")}emitBuffered(){this.receiveBuffer.forEach(t=>this.emitEvent(t)),this.receiveBuffer=[],this.sendBuffer.forEach(t=>{this.notifyOutgoingListeners(t),this.packet(t)}),this.sendBuffer=[]}ondisconnect(){this.destroy(),this.onclose("io server disconnect")}destroy(){this.subs&&(this.subs.forEach(t=>t()),this.subs=void 0),this.io._destroy(this)}disconnect(){return this.connected&&this.packet({type:Zt.DISCONNECT}),this.destroy(),this.connected&&this.onclose("io client disconnect"),this}close(){return this.disconnect()}compress(t){return this.flags.compress=t,this}get volatile(){return this.flags.volatile=!0,this}timeout(t){return this.flags.timeout=t,this}onAny(t){return this._anyListeners=this._anyListeners||[],this._anyListeners.push(t),this}prependAny(t){return this._anyListeners=this._anyListeners||[],this._anyListeners.unshift(t),this}offAny(t){if(!this._anyListeners)return this;if(t){const e=this._anyListeners;for(let i=0;i<e.length;i++)if(t===e[i])return e.splice(i,1),this}else this._anyListeners=[];return this}listenersAny(){return this._anyListeners||[]}onAnyOutgoing(t){return this._anyOutgoingListeners=this._anyOutgoingListeners||[],this._anyOutgoingListeners.push(t),this}prependAnyOutgoing(t){return this._anyOutgoingListeners=this._anyOutgoingListeners||[],this._anyOutgoingListeners.unshift(t),this}offAnyOutgoing(t){if(!this._anyOutgoingListeners)return this;if(t){const e=this._anyOutgoingListeners;for(let i=0;i<e.length;i++)if(t===e[i])return e.splice(i,1),this}else this._anyOutgoingListeners=[];return this}listenersAnyOutgoing(){return this._anyOutgoingListeners||[]}notifyOutgoingListeners(t){if(this._anyOutgoingListeners&&this._anyOutgoingListeners.length){const e=this._anyOutgoingListeners.slice();for(const i of e)i.apply(this,t.data)}}}function Gs(n){n=n||{},this.ms=n.min||100,this.max=n.max||1e4,this.factor=n.factor||2,this.jitter=n.jitter>0&&n.jitter<=1?n.jitter:0,this.attempts=0}Gs.prototype.duration=function(){var n=this.ms*Math.pow(this.factor,this.attempts++);if(this.jitter){var t=Math.random(),e=Math.floor(t*this.jitter*n);n=(Math.floor(t*10)&1)==0?n-e:n+e}return Math.min(n,this.max)|0};Gs.prototype.reset=function(){this.attempts=0};Gs.prototype.setMin=function(n){this.ms=n};Gs.prototype.setMax=function(n){this.max=n};Gs.prototype.setJitter=function(n){this.jitter=n};class cc extends ye{constructor(t,e){var i;super(),this.nsps={},this.subs=[],t&&typeof t=="object"&&(e=t,t=void 0),e=e||{},e.path=e.path||"/socket.io",this.opts=e,aa(this,e),this.reconnection(e.reconnection!==!1),this.reconnectionAttempts(e.reconnectionAttempts||1/0),this.reconnectionDelay(e.reconnectionDelay||1e3),this.reconnectionDelayMax(e.reconnectionDelayMax||5e3),this.randomizationFactor((i=e.randomizationFactor)!==null&&i!==void 0?i:.5),this.backoff=new Gs({min:this.reconnectionDelay(),max:this.reconnectionDelayMax(),jitter:this.randomizationFactor()}),this.timeout(e.timeout==null?2e4:e.timeout),this._readyState="closed",this.uri=t;const s=e.parser||eE;this.encoder=new s.Encoder,this.decoder=new s.Decoder,this._autoConnect=e.autoConnect!==!1,this._autoConnect&&this.open()}reconnection(t){return arguments.length?(this._reconnection=!!t,t||(this.skipReconnect=!0),this):this._reconnection}reconnectionAttempts(t){return t===void 0?this._reconnectionAttempts:(this._reconnectionAttempts=t,this)}reconnectionDelay(t){var e;return t===void 0?this._reconnectionDelay:(this._reconnectionDelay=t,(e=this.backoff)===null||e===void 0||e.setMin(t),this)}randomizationFactor(t){var e;return t===void 0?this._randomizationFactor:(this._randomizationFactor=t,(e=this.backoff)===null||e===void 0||e.setJitter(t),this)}reconnectionDelayMax(t){var e;return t===void 0?this._reconnectionDelayMax:(this._reconnectionDelayMax=t,(e=this.backoff)===null||e===void 0||e.setMax(t),this)}timeout(t){return arguments.length?(this._timeout=t,this):this._timeout}maybeReconnectOnOpen(){!this._reconnecting&&this._reconnection&&this.backoff.attempts===0&&this.reconnect()}open(t){if(~this._readyState.indexOf("open"))return this;this.engine=new op(this.uri,this.opts);const e=this.engine,i=this;this._readyState="opening",this.skipReconnect=!1;const s=vn(e,"open",function(){i.onopen(),t&&t()}),r=a=>{this.cleanup(),this._readyState="closed",this.emitReserved("error",a),t?t(a):this.maybeReconnectOnOpen()},o=vn(e,"error",r);if(this._timeout!==!1){const a=this._timeout,l=this.setTimeoutFn(()=>{s(),r(new Error("timeout")),e.close()},a);this.opts.autoUnref&&l.unref(),this.subs.push(()=>{this.clearTimeoutFn(l)})}return this.subs.push(s),this.subs.push(o),this}connect(t){return this.open(t)}onopen(){this.cleanup(),this._readyState="open",this.emitReserved("open");const t=this.engine;this.subs.push(vn(t,"ping",this.onping.bind(this)),vn(t,"data",this.ondata.bind(this)),vn(t,"error",this.onerror.bind(this)),vn(t,"close",this.onclose.bind(this)),vn(this.decoder,"decoded",this.ondecoded.bind(this)))}onping(){this.emitReserved("ping")}ondata(t){try{this.decoder.add(t)}catch(e){this.onclose("parse error",e)}}ondecoded(t){oa(()=>{this.emitReserved("packet",t)},this.setTimeoutFn)}onerror(t){this.emitReserved("error",t)}socket(t,e){let i=this.nsps[t];return i?this._autoConnect&&!i.active&&i.connect():(i=new lp(this,t,e),this.nsps[t]=i),i}_destroy(t){const e=Object.keys(this.nsps);for(const i of e)if(this.nsps[i].active)return;this._close()}_packet(t){const e=this.encoder.encode(t);for(let i=0;i<e.length;i++)this.engine.write(e[i],t.options)}cleanup(){this.subs.forEach(t=>t()),this.subs.length=0,this.decoder.destroy()}_close(){this.skipReconnect=!0,this._reconnecting=!1,this.onclose("forced close")}disconnect(){return this._close()}onclose(t,e){var i;this.cleanup(),(i=this.engine)===null||i===void 0||i.close(),this.backoff.reset(),this._readyState="closed",this.emitReserved("close",t,e),this._reconnection&&!this.skipReconnect&&this.reconnect()}reconnect(){if(this._reconnecting||this.skipReconnect)return this;const t=this;if(this.backoff.attempts>=this._reconnectionAttempts)this.backoff.reset(),this.emitReserved("reconnect_failed"),this._reconnecting=!1;else{const e=this.backoff.duration();this._reconnecting=!0;const i=this.setTimeoutFn(()=>{t.skipReconnect||(this.emitReserved("reconnect_attempt",t.backoff.attempts),!t.skipReconnect&&t.open(s=>{s?(t._reconnecting=!1,t.reconnect(),this.emitReserved("reconnect_error",s)):t.onreconnect()}))},e);this.opts.autoUnref&&i.unref(),this.subs.push(()=>{this.clearTimeoutFn(i)})}}onreconnect(){const t=this.backoff.attempts;this._reconnecting=!1,this.backoff.reset(),this.emitReserved("reconnect",t)}}const er={};function Ro(n,t){typeof n=="object"&&(t=n,n=void 0),t=t||{};const e=WS(n,t.path||"/socket.io"),i=e.source,s=e.id,r=e.path,o=er[s]&&r in er[s].nsps,a=t.forceNew||t["force new connection"]||t.multiplex===!1||o;let l;return a?l=new cc(i,t):(er[s]||(er[s]=new cc(i,t)),l=er[s]),e.query&&!t.query&&(t.query=e.queryKey),l.socket(e.path,t)}Object.assign(Ro,{Manager:cc,Socket:lp,io:Ro,connect:Ro});const sn=Ro({path:"/socket.io",autoConnect:!1,reconnection:!0,reconnectionDelay:500,reconnectionDelayMax:3e3});function iE(){sn.connected||sn.connect()}const Zh=500,Jh=500,qt=Ar({connected:!1,everConnected:!1,agents:[],states:{},current:"",chat:[],output:[],terrainCache:{},terrainLoading:!1,lastError:""});let cp=0;function sE(n){return!!n&&typeof n=="object"&&n.gameplay&&typeof n.gameplay=="object"&&typeof n.gameplay.health=="number"&&n.inventory&&typeof n.inventory=="object"&&n.inventory.counts&&typeof n.inventory.counts=="object"}function rE(n){const t={};if(!n||typeof n!="object")return t;const e=[];for(const[s,r]of Object.entries(n))sE(r)?t[s]=r:e.push(s);const i=n.error;return i?qt.lastError="状态尚未就绪："+String(i):e.length&&(qt.lastError=`状态数据不完整（${e.join(", ")}），已忽略；通常出现在首次 full_state 超时之后`),t}const Xn=ts(()=>{const n=qt.agents;return n.length?n.find(t=>t.name===qt.current)||n[0]:null}),il=ts(()=>{const n=Xn.value;return n&&qt.states[n.name]||null});function Qh(n){qt.chat.push({...n,seq:++cp,t:Date.now()}),qt.chat.length>Zh&&qt.chat.splice(0,qt.chat.length-Zh)}function oE(n){qt.output.push({...n,seq:++cp,t:Date.now()}),qt.output.length>Jh&&qt.output.splice(0,qt.output.length-Jh)}let tf=!1;function aE(){tf||(tf=!0,sn.on("connect",()=>{qt.connected=!0,qt.everConnected=!0,qt.lastError="",sn.emit("listen-to-agents")}),sn.on("disconnect",()=>{qt.connected=!1,qt.states={},qt.lastError="与 mindserver 断开，正在重连…"}),sn.on("connect_error",n=>{qt.connected=!1,qt.lastError="连不上 mindserver(8080)："+((n==null?void 0:n.message)||"unknown")}),sn.on("agents-status",n=>{var t;qt.agents=Array.isArray(n)?n:[],qt.agents.some(e=>e.name===qt.current)||(qt.current=((t=qt.agents[0])==null?void 0:t.name)||"")}),sn.on("state-update",n=>{qt.states=rE(n)}),sn.on("bot-output",(n,t)=>{t&&(oE({agent:n,text:String(t)}),Qh({kind:n==="system"?"system":"her",agent:n,text:String(t)}))}),sn.on("chat-message",(n,t)=>{const e=t==null?void 0:t.message;e&&Qh({kind:"system",agent:n,text:`${n}: ${e}`})}),iE())}async function lE(n={}){const t=Xn.value;if(!t)return null;qt.terrainLoading=!0;try{const e=await new Promise(i=>{const s=setTimeout(()=>i({ok:!1,reason:"超时(30s)"}),31e3);sn.emit("request-terrain",t.name,{mode:n.mode||"around",radius:n.radius??48,lod:n.lod??2},r=>{clearTimeout(s),i(r||{ok:!1,reason:"no response"})})});return e.ok?qt.terrainCache[t.name]=e:qt.lastError="地形加载失败："+(e.reason||"unknown"),e}finally{qt.terrainLoading=!1}}const xt=Ar({mode:"around",radius:48,lod:2,showTypes:[!0,!0,!0,!0,!0,!0,!0],yMin:-64,yMax:320,topOnly:!1,showFails:!0,owner:"",dimension:"",decoded:null,stats:""});function ef(n){const t=atob(n),e=new Uint8Array(t.length);for(let i=0;i<t.length;i++)e[i]=t.charCodeAt(i);return e}let jc=0;function Ho(){var e;const n=Xn.value,t=n?qt.states[n.name]:null;return((e=t==null?void 0:t.gameplay)==null?void 0:e.dimension)??"unknown"}function up(n,t){var v,m;if(t){const f=((v=Xn.value)==null?void 0:v.name)??"",w=Ho();if(t.seq!==jc)return xt.stats="已丢弃过期地形响应（期间又发起了新的加载）",null;if(t.owner!==f)return xt.stats=`已丢弃 ${t.owner} 的地形响应（当前是 ${f||"未选择"}）`,null;if(t.dimension!==w)return xt.stats=`已丢弃 ${t.dimension} 的地形响应（当前维度是 ${w}）`,null}if(!(n!=null&&n.ok)||!n.origin||!n.pos||!n.types)return xt.decoded=null,xt.owner="",xt.dimension="",xt.stats=(n==null?void 0:n.reason)||"无数据",null;const[e,i,s]=n.origin,r=ef(n.pos),o=n.dtype==="int32"?new Int32Array(r.buffer,r.byteOffset,r.byteLength/4):new Int16Array(r.buffer,r.byteOffset,r.byteLength/2),a=ef(n.types),l=Math.min(n.count||0,Math.floor(o.length/3)),u=new Float32Array(l),c=new Float32Array(l),h=new Float32Array(l),d=new Uint8Array(l);for(let f=0;f<l;f++)u[f]=o[f*3]+e,c[f]=o[f*3+1]+i,h[f]=o[f*3+2]+s,d[f]=a[f];const p=n.bbox||{x0:Math.min(...u),x1:Math.max(...u),z0:Math.min(...h),z1:Math.max(...h),y0:Math.min(...c),y1:Math.max(...c)};xt.decoded={x:u,y:c,z:h,t:d,count:l,bbox:p,fails:n.fails||[]},xt.owner=((m=Xn.value)==null?void 0:m.name)??"",xt.dimension=Ho(),xt.yMin=p.y0,xt.yMax=p.y1;const g=new Set;for(let f=0;f<l;f++)g.add(u[f]+","+Math.floor(h[f]));return xt.stats=`${l.toLocaleString()} 面 · ${g.size.toLocaleString()} 列 · y ${p.y0}~${p.y1} · lod ${n.lod??1} · ${n.ms??"?"}ms`,xt.decoded}async function cE(){const n=Xn.value;if(!n)return null;const t={owner:n.name,dimension:Ho(),seq:++jc},e=await lE({mode:xt.mode,radius:xt.radius,lod:xt.lod});return up(e,t)}bi(()=>{var n;return[((n=Xn.value)==null?void 0:n.name)??"",Ho()].join("|")},()=>{xt.decoded&&(xt.decoded=null,xt.owner="",xt.dimension="",xt.stats="已切换 bot / 维度：旧地形已清空，请重新加载",jc++)});const nf=ts(()=>{var n;return!!((n=Xn.value)!=null&&n.in_game)}),uE={class:"wrap"},hE={class:"panel side"},fE={class:"body"},dE={class:"row"},pE={key:0,class:"row"},mE={class:"num k2"},_E=["disabled"],gE={key:1,class:"faint tip"},vE={key:2,class:"tip bad"},xE={key:3,class:"stats num"},yE=["checked","onChange"],ME={class:"faint code"},SE={class:"chk"},EE={class:"faint code"},bE={class:"slice"},TE=["min","max"],AE={class:"num k2"},wE={class:"slice"},RE=["min","max"],CE={class:"num k2"},PE={class:"chk"},DE={class:"row btns"},LE={class:"hintbar faint"},IE=bc({__name:"TerrainView",setup(n){const t=gr(null),e=gr(""),i=ts(()=>xt.decoded),s=ts(()=>{var c;const u=(c=il.value)==null?void 0:c.gameplay.position;return u?{x:u.x,y:u.y,z:u.z}:null}),r=ts(()=>{var c;const u=(c=xt.decoded)==null?void 0:c.bbox;return u?{min:u.y0,max:u.y1}:{min:-64,max:320}});async function o(){e.value="",await cE()||(e.value=qt.lastError||"没有拿到地形数据")}function a(u){const c=xt.showTypes.slice();c[u]=!c[u],xt.showTypes=c}Ac(()=>{});const l=Object.entries(sc).map(([u,c])=>({code:Number(u),...c}));return(u,c)=>{var h,d;return nn(),_n("div",uE,[Xe(hS,{ref_key:"canvasRef",ref:t,data:i.value,"show-types":jt(xt).showTypes,"y-min":jt(xt).yMin,"y-max":jt(xt).yMax,"top-only":jt(xt).topOnly,"show-fails":jt(xt).showFails,marker:s.value},null,8,["data","show-types","y-min","y-max","top-only","show-fails","marker"]),Ot("aside",hE,[c[19]||(c[19]=Ot("div",{class:"panel-title"},"数据",-1)),Ot("div",fE,[Ot("div",dE,[Ui(Ot("select",{"onUpdate:modelValue":c[0]||(c[0]=p=>jt(xt).mode=p)},[...c[9]||(c[9]=[Ot("option",{value:"around"},"以她为中心",-1),Ot("option",{value:"full"},"全图",-1)])],512),[[Nu,jt(xt).mode]]),Ui(Ot("select",{"onUpdate:modelValue":c[1]||(c[1]=p=>jt(xt).lod=p)},[...c[10]||(c[10]=[Ot("option",{value:1},"lod 1 全量",-1),Ot("option",{value:2},"lod 2",-1),Ot("option",{value:4},"lod 4 粗",-1)])],512),[[Nu,jt(xt).lod,void 0,{number:!0}]])]),jt(xt).mode==="around"?(nn(),_n("div",pE,[c[11]||(c[11]=Ot("span",{class:"faint k"},"半径",-1)),Ui(Ot("input",{"onUpdate:modelValue":c[2]||(c[2]=p=>jt(xt).radius=p),type:"range",min:"16",max:"128",step:"8"},null,512),[[Sa,jt(xt).radius,void 0,{number:!0}]]),Ot("span",mE,en(jt(xt).radius),1)])):Wi("",!0),Ot("button",{class:"primary",disabled:!jt(nf)||jt(qt).terrainLoading,onClick:o},en(jt(qt).terrainLoading?"读取中…":"加载地形"),9,_E),jt(nf)?Wi("",!0):(nn(),_n("div",gE,"agent 不在线，地形读不到（数据在 agent 进程里）")),e.value?(nn(),_n("div",vE,en(e.value),1)):Wi("",!0),jt(xt).stats?(nn(),_n("div",xE,en(jt(xt).stats),1)):Wi("",!0),c[17]||(c[17]=Ot("div",{class:"panel-title inner"},"图层",-1)),(nn(!0),_n(We,null,Sm(jt(l),p=>(nn(),_n("label",{key:p.code,class:"chk"},[Ot("input",{type:"checkbox",checked:jt(xt).showTypes[p.code],onChange:g=>a(p.code)},null,40,yE),Ot("i",{class:"sw",style:Yo({background:p.color})},null,4),Ot("span",null,en(p.name),1),Ot("span",ME,en(p.code),1)]))),128)),Ot("label",SE,[Ui(Ot("input",{"onUpdate:modelValue":c[3]||(c[3]=p=>jt(xt).showFails=p),type:"checkbox"},null,512),[[Iu,jt(xt).showFails]]),c[12]||(c[12]=Ot("i",{class:"sw",style:{background:"#ff4444"}},null,-1)),c[13]||(c[13]=Ot("span",null,"失败点",-1)),Ot("span",EE,en(((h=i.value)==null?void 0:h.fails.length)??0),1)]),c[18]||(c[18]=Ot("div",{class:"panel-title inner"},"高度切片",-1)),Ot("div",bE,[c[14]||(c[14]=Ot("span",{class:"faint k"},"下限",-1)),Ui(Ot("input",{"onUpdate:modelValue":c[4]||(c[4]=p=>jt(xt).yMin=p),type:"range",min:r.value.min,max:r.value.max},null,8,TE),[[Sa,jt(xt).yMin,void 0,{number:!0}]]),Ot("span",AE,en(jt(xt).yMin),1)]),Ot("div",wE,[c[15]||(c[15]=Ot("span",{class:"faint k"},"上限",-1)),Ui(Ot("input",{"onUpdate:modelValue":c[5]||(c[5]=p=>jt(xt).yMax=p),type:"range",min:r.value.min,max:r.value.max},null,8,RE),[[Sa,jt(xt).yMax,void 0,{number:!0}]]),Ot("span",CE,en(jt(xt).yMax),1)]),Ot("label",PE,[Ui(Ot("input",{"onUpdate:modelValue":c[6]||(c[6]=p=>jt(xt).topOnly=p),type:"checkbox"},null,512),[[Iu,jt(xt).topOnly]]),c[16]||(c[16]=Ot("span",null,"只看最上层",-1))]),Ot("div",DE,[Ot("button",{onClick:c[7]||(c[7]=p=>{var g;return(g=t.value)==null?void 0:g.resetView()})},"重置视角"),Ot("button",{onClick:c[8]||(c[8]=p=>{jt(xt).yMin=r.value.min,jt(xt).yMax=r.value.max})},"重置切片")])])]),Ot("div",LE,[c[20]||(c[20]=_o(" 拖拽旋转 · 滚轮缩放 · 右键平移 · ",-1)),jt(Xn)?(nn(),_n(We,{key:0},[_o(" agent "+en(jt(Xn).name),1)],64)):Wi("",!0),(d=jt(il))!=null&&d.facing?(nn(),_n(We,{key:1},[_o(" · 朝向 "+en(jt(il).facing.text),1)],64)):Wi("",!0)])])}}}),UE=jd(IE,[["__scopeId","data-v-e8d66cce"]]),NE={name:"t4-stub",in_game:!0,socket_connected:!0,viewer_port:0},OE="minecraft:overworld",hp=n=>{qt.states["t4-stub"]={gameplay:{health:20,position:n,dimension:OE},inventory:{counts:{}}}};hp({x:0,y:64,z:0});const Kc=()=>{qt.agents.some(n=>n.name==="t4-stub")||qt.agents.push(NE)};Kc();aE();sn.on("agents-status",()=>{setTimeout(Kc,0)});const FE=setInterval(Kc,200);setTimeout(()=>clearInterval(FE),6e4);function sf(n){let t="";for(let e=0;e<n.length;e++)t+=String.fromCharCode(n[e]);return btoa(t)}function BE(n){const t=n.cols??40,e=n.heights??4,[i,s,r]=n.origin??[-100,60,-100],o=n.fails??0;let a=n.seed??12345;const l=()=>(a=a*1103515245+12345&2147483647,a/2147483647),u=t*t*e,c=new Int16Array(u*3),h=new Uint8Array(u);let d=0,p=1/0,g=-1/0;for(let b=0;b<t;b++)for(let x=0;x<t;x++){const B=1+Math.floor(l()*e);for(let P=0;P<B;P++)c[d*3]=b,c[d*3+1]=P,c[d*3+2]=x,h[d]=(b+x+P)%7,P<p&&(p=P),P>g&&(g=P),d++}const v=d,m=sf(new Uint8Array(c.buffer,0,v*3*2)),f=sf(h.subarray(0,v)),w=[];for(let b=0;b<o;b++)w.push({x:Math.floor(l()*t),y:g+1,z:Math.floor(l()*t),hits:1+Math.floor(l()*9)});return{ok:!0,origin:[i,s,r],dtype:"int16",count:v,pos:m,types:f,bbox:{x0:i,x1:i+t,z0:r,z1:r+t,y0:s,y1:s+(g-p)},fails:w,lod:1,mode:"around",ms:7}}const uc=gr(!0),zE=gr(!0),kE={load(n={}){const t=BE(n),e=up(t);return{ok:!!e,count:(e==null?void 0:e.count)??0,fails:(e==null?void 0:e.fails.length)??0,stats:xt.stats,bbox:(e==null?void 0:e.bbox)??null}},setFails(n){const t=xt.decoded;if(!t)return{ok:!1,reason:"no data"};const e=t.bbox,i=[];for(let s=0;s<n;s++)i.push({x:e.x0+s%64,y:e.y0+1+s%3,z:e.z0+Math.floor(s/64),hits:1+s%9});return t.fails=i,{ok:!0,fails:i.length}},tickMarker(n){const t=xt.decoded,e=t==null?void 0:t.bbox,i=e?{x:e.x0+n%20,y:e.y0+1,z:e.z0+n%17}:{x:n,y:64,z:0};return hp(i),i},setMarkerVisible(n){zE.value=n},unmount(){return uc.value=!1,!0},remount(){return uc.value=!0,!0},state(){var n,t,e;return{hasData:!!xt.decoded,count:((n=xt.decoded)==null?void 0:n.count)??0,fails:((t=xt.decoded)==null?void 0:t.fails.length)??0,stats:xt.stats,bbox:((e=xt.decoded)==null?void 0:e.bbox)??null,yMin:xt.yMin,yMax:xt.yMax,showFails:xt.showFails,mode:xt.mode}},setShowFails(n){xt.showFails=n},setTopOnly(n){xt.topOnly=n},setSlice(n,t){xt.yMin=n,xt.yMax=t},setShowTypes(n){xt.showTypes=n}};window.__t4ctl=kE;window.__t4diag={revision:ea,renderPatched:/__t4/.test(String(ko.prototype.render)),rendererName:ko.name};window.__t4store={store:qt,terrain:xt};const HE=bc({name:"T4Fixture",render:()=>Br("div",{style:"height:100vh;display:flex;flex-direction:column;font:14px system-ui"},[Br("div",{style:"flex:none;padding:5px 10px;background:#1f1f1f;color:#ddd;font-size:12px"},"T4 fixture · 真实 TerrainView + TerrainCanvas（web/src 未改动）· 数据为合成注入"),Br("div",{style:"flex:1;min-height:0"},uc.value?[Br(UE)]:[])])});N_(HE).mount("#app");
