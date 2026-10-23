"""Mirror pinned upstream source archives without extracting or executing them."""
import concurrent.futures, hashlib, json, pathlib, sys, urllib.request, zipfile
root=pathlib.Path(__file__).resolve().parents[1]
manifest_path=root/'licenses/native-sources.json'
manifest=json.loads(manifest_path.read_text())
cache=root/'release/dependency-source-cache'
cache.mkdir(parents=True,exist_ok=True)
def download(entry):
    target=cache/entry['filename']
    if not target.exists():
        temporary=target.with_suffix(target.suffix+'.tmp')
        request=urllib.request.Request(entry['url'],headers={'User-Agent':'IntelBoard-source-mirror/1.0'})
        with urllib.request.urlopen(request,timeout=60) as response, temporary.open('wb') as output:
            size=0
            while chunk:=response.read(1024*1024):
                size+=len(chunk)
                if size>200*1024*1024: raise ValueError('Source file exceeds 200 MB')
                output.write(chunk)
        temporary.replace(target)
    checksum=hashlib.file_digest(target.open('rb'),'sha256').hexdigest()
    if entry.get('sha256') and entry['sha256']!=checksum: raise ValueError('Source checksum mismatch: '+entry['filename'])
    entry['sha256']=checksum
    entry['size']=target.stat().st_size
    print('Verified',entry['filename'],flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
    list(executor.map(download,manifest['sources']))
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
version=json.loads((root/'package.json').read_text())['version']
archive=root/f'release/IntelBoard-{version}-dependency-sources.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_STORED) as bundle:
    bundle.writestr('SOURCES.json',json.dumps(manifest,indent=2)+'\n')
    bundle.writestr('README.txt','Upstream source archives and patches for the Sharp/libvips native libraries distributed with IntelBoard. Sources are unchanged. Apply patches and build-time edits using the included upstream build recipes. The IntelBoard repository includes library replacement instructions and license notices. Archives are nested; no file has been automatically extracted or executed.\n')
    for entry in manifest['sources']: bundle.write(cache/entry['filename'],'sources/'+entry['filename'])
    for name in ['GPL-3.0.txt','LGPL-3.0.txt']:bundle.write(root/'licenses'/name,'licenses/'+name)
print('Created',archive.name,archive.stat().st_size,'bytes',flush=True)
