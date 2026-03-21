import https from 'https';

const urls = [
    'https://industrycity.com/tenants/colson-patisserie/',
    'https://www.yafacafe.com/',
    'https://www.japanvillage.com/',
    'https://industrycity.com/the-makers-guild/',
    'https://www.beatthebomb.com/',
    'https://movementgyms.com/gowanus/',
    'https://www.kickaxe.com/brooklyn',
    'https://www.brooklyngameknight.com/',
    'https://www.carreauclub.com/',
    'https://industrycity.com/tenants/wakuwaku/',
    'https://industrycity.com/tenants/hometown-bar-b-que/'
];

function fetchURL(url) {
    return new Promise((resolve) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                return resolve(fetchURL(res.headers.location));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const match = data.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i) || 
                              data.match(/<meta\s+content="([^"]+)"\s+(?:property|name)="og:image"/i);
                resolve({ url, root: url, image: match ? match[1] : 'NOT_FOUND' });
            });
        }).on('error', () => resolve({ url, root: url, image: 'ERROR' }));
    });
}

Promise.all(urls.map(url => fetchURL(url))).then(results => {
    results.forEach(r => console.log(r.root + ' -> ' + r.image));
});
