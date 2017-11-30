if (typeof window === 'object' && window.navigator && (/node\.js/i).test(window.navigator.userAgent)) {
    let addons = require('@kadira/storybook-addons').default;
    let Channel = require('@kadira/storybook-channel').default;
    addons.setChannel(new Channel({
        transport: {
            setHandler: function() {},
            send: function() {}
        }
    }));
}

${configBody}

if (typeof window === 'object') {
    window.__storybook_stories__ = require('@kadira/storybook').getStorybook();
}