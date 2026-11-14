import adapter from '@sveltejs/adapter-vercel';
import preprocess from 'svelte-preprocess';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://github.com/sveltejs/svelte-preprocess
	// for more information about preprocessors
	preprocess: preprocess({
    postcss: true
	}),
	kit: {
		// Set the runtime explicitly: the adapter only auto-detects Node 16/18/20,
		// and Vercel now builds with the version in package.json "engines".
		adapter: adapter({
			runtime: `nodejs${process.versions.node.split('.')[0]}.x`,
			// deploy endpoints download images and upload them to GitHub; the default limit
			// (10s on some plans) is too short for that. 60s is allowed on every plan.
			maxDuration: 60
		})
	},
	vitePlugin: {
		inspector: false
	},
	onwarn: (warning, handler) => {
		if(warning.filename.includes('svelte-json-tree')) {return}
		handler(warning);
	}
};

export default config;
