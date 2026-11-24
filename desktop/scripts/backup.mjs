import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
function verify(path) {
  const db=new DatabaseSync(path,{readOnly:true,allowExtension:false});
  try {
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if(integrity.length!==1 || integrity[0].integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw Error('SQLite validation failed.');
    for(const table of ['saves','devices','revisions','score_results','revoked_publishers']) db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get();
  } finally { db.close(); }
}
export async function snapshot(source,parent) {
  await mkdir(parent,{recursive:true,mode:0o700});
  const dir=await mkdtemp(join(parent,new Date().toISOString().replace(/:/g,'-')+'-'));
  const file=join(dir,'trainer.sqlite');
  const db=new DatabaseSync(source,{readOnly:true,allowExtension:false});
  try { db.prepare('VACUUM INTO ?').run(file); } finally { db.close(); }
  verify(file);
  await writeFile(join(dir,'sha256'),await hash(file)+'\n',{flag:'wx',mode:0o600});
  return dir;
}
export async function restore(snapshotDir,newDirectory) {
  const source=join(snapshotDir,'trainer.sqlite'), expected=(await readFile(join(snapshotDir,'sha256'),'utf8')).trim();
  if(await hash(source)!==expected) throw Error('Snapshot checksum mismatch.');
  verify(source);
  await mkdir(newDirectory,{mode:0o700}); // Refuse an existing restore destination.
  const dest=join(newDirectory,'trainer.sqlite');
  await copyFile(source,dest+'.part',constants.COPYFILE_EXCL);
  if(await hash(dest+'.part')!==expected) throw Error('Restored file did not match the snapshot.');
  verify(dest+'.part');await rename(dest+'.part',dest);return dest;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const [op,source,dest]=process.argv.slice(2);
  if (!source || !dest || !['snapshot','restore'].includes(op)) throw Error('Usage: node scripts/backup.mjs snapshot DATABASE NEW_SNAPSHOT_PARENT or restore SNAPSHOT NEW_DIRECTORY');
  console.log(await (op==='snapshot'?snapshot:restore)(resolve(source),resolve(dest)));
}
