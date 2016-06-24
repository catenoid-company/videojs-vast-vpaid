'use strict';

var VASTClient = require('../ads/vast/VASTClient');
var VASTError = require('../ads/vast/VASTError');
var vastUtil = require('../ads/vast/vastUtil');

var VASTIntegrator = require('../ads/vast/VASTIntegrator');
var VPAIDIntegrator = require('../ads/vpaid/VPAIDIntegrator');

var async = require('../utils/async');
var dom = require('../utils/dom');
var playerUtils = require('../utils/playerUtils');
var utilities = require('../utils/utilityFunctions');

var logger = require ('../utils/consoleLogger');

module.exports = function VASTPlugin(options) {
	var player = this,
		blackPoster = playerUtils.prepareForAds(player, options.filter(function(el) {
			return el.rollPosition === 'preroll';
		}).length > 0); // prepareForAds는 한번만 실행하도록 하며, preroll이 존재하는 경우엔 함수 실행시 blackPoster를 생성한다.

	// options로 들어온 재생이 필요한 광고 배열을
	// 순회하면서 모두 PlayVASTAd 인스턴스를 생성한다.
	options.forEach(function(option) {
		PlayVASTAd.create(utilities.extend({}, option, {
			player: player,
			blackPoster: blackPoster
		}));
	});
};

var PlayVASTAd = function(options) {
		this.snapshot;
		this.player = options.player; // VASTPlugin function에서 직접 player object를 주입한다.
		this.vast = new VASTClient();
		this.adsCanceled = false;
		this.settings = utilities.extend({}, {
			timeout: 1000, // 각종 스크립트들이 로딩되는데 걸리는 최대 timeout 시간. 기본 500ms였으나 종종 문제가 생기므로 1000으로 늘림.
			iosPrerollCancelTimeout: 2000,
			adCancelTimeout: 1000,
			playAdAlways: false,
			adsEnabled: true,
			autoResize: true,
			vpaidFlashLoaderPath: '/VPAIDFlash.swf',
			verbosity: 0,

			player: null,
			blackPoster: null
		}, options || {});
	};

PlayVASTAd.create = function(option) {
	return (new PlayVASTAd(option)).initialize();
};

PlayVASTAd.prototype.cancelAds = function() {
	this.player.trigger('vast.adsCancel');
	this.adsCanceled = true;
};

PlayVASTAd.prototype.trackAdError = function(error, vastResponse) {
	this.player.trigger({type: 'vast.adError', error: error});
	this.cancelAds();
	logger.error('AD ERROR:', error.message, error, vastResponse);
};

PlayVASTAd.prototype.initialize = function() {
	var self = this,
		settings = this.settings;

	if(typeof settings.adTagUrl === 'undefined' && typeof settings.url !== 'undefined') {
		settings.adTagUrl = settings.url;
	}

	if(typeof settings.adTagUrl === 'string') {
		settings.adTagUrl = (function(adTagUrl) {
			return function() {
				return adTagUrl;
			};
		})(settings.adTagUrl);
	}

	if(typeof settings.adTagXML !== 'undefined' && typeof settings.adTagXML !== 'function') {
		return this.trackAdError(new VASTError('on VideoJS VAST plugin, the passed adTagXML option does not contain a function'));
	}

	if(typeof settings.adTagUrl === 'undefined' && typeof settings.adTagXML !== 'function') {
		return this.trackAdError(new VASTError('on VideoJS VAST plugin, missing adTagUrl on options object'));
	}

	logger.setVerbosity(settings.verbosity);
	vastUtil.runFlashSupportCheck(settings.vpaidFlashLoaderPath); // Necessary step for VPAIDFLASHClient to work.

	if(settings.playAdAlways) {
		// No matter what happens we play a new ad before the user sees the video again.
		this.player.on('vast.contentEnd', function () {
			setTimeout(function () {
				self.player.trigger('vast.reset');
			}, 0);
		});
	}

	this.player.on('vast.reset', function() {
		//If we are reseting the plugin, we don't want to restore the content
		self.snapshot = null;
		self.cancelAds();
	});

	// player의 promotionController로부터 전달받은
	// 광고의 time offset에 해당하는 custom event에 광고재생 callback
	// 을 이벤트 리스너로 걸어준다.
	// 다만 광고는 한 번 재생되면 다시 재생되어선 안되기 때문에
	// 일회성 listener를 건다.
	if(typeof settings.offset === 'undefined' || settings.offset < 0) {
		return this.trackAdError(new VASTError('invalid ad offset.'));
	}

	if(settings.rollPosition === 'preroll') {
		this.player.on('vast.firstPlay', this.tryToPlayPrerollAd.bindTo(this));
	} else if(settings.rollPosition === 'midroll') {
		this.player.one('vast.timeUpdate:' + settings.offset, this.tryToPlayMidrollAd.bindTo(this));
	} else if(settings.rollPosition === 'postroll') {
		this.player.one('vast.timeEnd', this.tryToPlayPostrollAd.bindTo(this));
	}

	this.player.vast = {
		isEnabled: function () {
			return settings.adsEnabled;
		},
		enable: function () {
			settings.adsEnabled = true;
		},
		disable: function () {
			settings.adsEnabled = false;
		}
	};

	return true;
};

PlayVASTAd.prototype.removeAdUnit = function() {
	if(this.player.vast && this.player.vast.adUnit) {
		this.player.vast.adUnit = null; //We remove the adUnit
	}
};

PlayVASTAd.prototype.restoreVideoContent = function() {
	this.setupContentEvents();
	if(this.snapshot) {
		playerUtils.restorePlayerSnapshot(this.player, this.snapshot);
		this.snapshot = null;
	}
};

PlayVASTAd.prototype.restoreVideoContentAsContentEnded = function() {
	if(this.snapshot) {
		playerUtils.restorePlayerSnapshot(this.player, this.snapshot);
		this.snapshot = null;
	}
};

PlayVASTAd.prototype.setupContentEvents = function() {
	var self = this;

	playerUtils.once(this.player, ['playing', 'vast.reset', 'vast.firstPlay'], function (evt) {
		if(evt.type !== 'playing') {
			return;
		}

		self.player.trigger('vast.contentStart');

		playerUtils.once(self.player, ['ended', 'vast.reset', 'vast.firstPlay'], function (evt) {
			if(evt.type === 'ended') {
				self.player.trigger('vast.contentEnd');
			}
		});
	});
};

PlayVASTAd.prototype.checkAdsEnabled = function(next) {
	if(this.settings.adsEnabled) {
	  return next(null);
	}

	next(new VASTError('Ads are not enabled'));
};

PlayVASTAd.prototype.preparePlayerForAd = function(next) {
	var self = this;

	if(this.canPlayPrerollAd()) {
		this.snapshot = playerUtils.getPlayerSnapshot(this.player);
		this.player.pause();
		this.addSpinnerIcon();

		if(this.player.paused()) {
			next(null);
		} else {
			playerUtils.once(this.player, ['playing'], function() {
				self.player.pause();
				next(null);
			});
		}
	} else {
		next(new VASTError('video content has been playing before preroll ad'));
	}
};

PlayVASTAd.prototype.startAdCancelTimeout = function(next) {
	var self = this,
		adCancelTimeoutId;

	this.adsCanceled = false;

	adCancelTimeoutId = setTimeout(function () {
		self.trackAdError(new VASTError('timeout while waiting for the video to start playing', 402));
	}, this.settings.adCancelTimeout);

	playerUtils.once(this.player, ['vast.adStart', 'vast.adsCancel'], function clearAdCancelTimeout() {
		if(adCancelTimeoutId) {
			clearTimeout(adCancelTimeoutId);
			adCancelTimeoutId = null;
		}
	});

	next(null);
};

PlayVASTAd.prototype.playPrerollAd = function(callback) {
	var self = this;

	async.waterfall([
		function(callback) {
			self.getVastResponse(callback);
		},
		function(vastResponse, callback) {
			self.playAd(vastResponse, callback);
		}
	], callback);
};

PlayVASTAd.prototype.getVastResponse = function(callback) {
	this.vast.getVASTResponse(this.settings.adTagUrl ? this.settings.adTagUrl() : this.settings.adTagXML, callback);
};

PlayVASTAd.prototype.playAd = function(vastResponse, callback) {
	var self = this;

	//TODO: Find a better way to stop the play. The 'playPrerollWaterfall' ends in an inconsistent situation
	//If the state is not 'preroll?' it means the ads were canceled therefore, we break the waterfall
	if(this.adsCanceled) {
		return;
	}

	var adIntegrator = this.isVPAID(vastResponse) ? new VPAIDIntegrator(this.player, this.settings) : new VASTIntegrator(this.player);
	var adFinished = false;

	playerUtils.once(this.player, ['vast.adStart'], addAdsLabel);
	playerUtils.once(this.player, ['vast.adEnd'], removeAdsLabel);

	if(utilities.isIDevice()) {
		preventManualProgress();
	}

	this.player.vast.vastResponse = vastResponse;
	logger.debug ("calling adIntegrator.playAd() with vastResponse:", vastResponse);
	this.player.vast.adUnit = adIntegrator.playAd(vastResponse, callback);

	function addAdsLabel() {
		if(adFinished || self.player.controlBar.getChild('AdsLabel')) {
			return;
		}

		self.player.controlBar.addChild('AdsLabel');
	}

	function removeAdsLabel() {
		self.player.controlBar.removeChild('AdsLabel');
		adFinished = true;
	}

	function preventManualProgress() {
		//IOS video clock is very unreliable and we need a 3 seconds threshold to ensure that the user forwarded/rewound the ad
		var PROGRESS_THRESHOLD = 3;
		var previousTime = 0;
		var skipad_attempts = 0;

		self.player.on('timeupdate', preventAdSeek);
		self.player.on('ended', preventAdSkip);
		playerUtils.once(self.player, ['vast.adEnd', 'vast.adsCancel', 'vast.adError'], stopPreventManualProgress);

		function preventAdSkip() {
			// Ignore ended event if the Ad time was not 'near' the end
			// and revert time to the previous 'valid' time
			if((self.player.duration() - previousTime) > PROGRESS_THRESHOLD) {
				self.player.pause(true); // this reduce the video jitter if the IOS skip button is pressed
				self.player.play(true); // we need to trigger the play to put the video element back in a valid state
				self.player.currentTime(previousTime);
			}
		}

		function preventAdSeek() {
			var currentTime = self.player.currentTime();
			var progressDelta = Math.abs(currentTime - previousTime);

			if(progressDelta > PROGRESS_THRESHOLD) {
				skipad_attempts += 1;

				if(skipad_attempts >= 2) {
					self.player.pause(true);
				}

				self.player.currentTime(previousTime);
			} else {
				previousTime = currentTime;
			}
		}

		function stopPreventManualProgress() {
			self.player.off('timeupdate', preventAdSeek);
			self.player.off('ended', preventAdSkip);
		}
	}
};

PlayVASTAd.prototype.isVPAID = function(vastResponse) {
	var i, len;
	var mediaFiles = vastResponse.mediaFiles;

	for(i = 0, len = mediaFiles.length; i < len; i++) {
		if(vastUtil.isVPAID(mediaFiles[i])) {
			return true;
		}
	}

	return false;
};

PlayVASTAd.prototype.canPlayPrerollAd = function() {
	return !utilities.isIPhone() || this.player.currentTime() <= this.settings.iosPrerollCancelTimeout;
};

PlayVASTAd.prototype.addSpinnerIcon = function() {
	dom.addClass(this.player.el(), 'vjs-vast-ad-loading');
	playerUtils.once(this.player, ['vast.adStart', 'vast.adsCancel', 'vast.adError'], this.removeSpinnerIcon.bindTo(this));
};

PlayVASTAd.prototype.removeSpinnerIcon = function() {
	var self = this;

	//IMPORTANT NOTE: We remove the spinnerIcon asynchronously to give time to the browser to start the video.
	// If we remove it synchronously we see a flash of the content video before the ad starts playing.
	setTimeout(function () {
		dom.removeClass(self.player.el(), 'vjs-vast-ad-loading');
	}, 100);
};

PlayVASTAd.prototype.tryToPlayAd = function() {
	var self = this;

	//We remove the poster to prevent flickering whenever the content starts playing
	playerUtils.removeNativePoster(this.player);

	// 영상 재생을 위한 sequencial한 callback list
	async.waterfall([
		this.checkAdsEnabled.bindTo(this),
		this.preparePlayerForAd.bindTo(this),
		this.startAdCancelTimeout.bindTo(this),
		this.playPrerollAd.bindTo(this)
	], function (error, response) {
		if(error) {
			self.trackAdError(error, response);
		} else {
			self.player.trigger('vast.adEnd');
		}
	});
};

PlayVASTAd.prototype.tryToPlayPrerollAd = function() {
	var self = this;

	// preroll 광고의 경우는 광고 시작전의 검은화면이
	// 이미 광고 셋업단계에서 수행되었으므로 추가로 수행하지 않는다.
	playerUtils.once(this.player, ['vast.adsCancel', 'vast.adEnd'], function() {
		self.removeAdUnit();
		self.restoreVideoContent();
	});

	// 본 광고 시작
	this.tryToPlayAd();
};

PlayVASTAd.prototype.tryToPlayMidrollAd = function() {
	var self = this;

	// 광고 시작 전의 검은 화면 표시
	// 광고가 끝나면 playerUtils쪽에서 자동으로 hide시킴
	// preroll의 경우는 initialize 이전에 이미 검은 화면을 표시함.
	this.settings.blackPoster.showBlackPoster();

	playerUtils.once(this.player, ['vast.adsCancel', 'vast.adEnd'], function() {
		self.removeAdUnit();
		self.restoreVideoContent();
	});

	// 본 광고 시작
	this.tryToPlayAd();
};

PlayVASTAd.prototype.tryToPlayPostrollAd = function() {
	var self = this;

	// 광고 시작 전의 검은 화면 표시
	// 광고가 끝나면 playerUtils쪽에서 자동으로 hide시킴
	// preroll의 경우는 initialize 이전에 이미 검은 화면을 표시함.
	this.settings.blackPoster.showBlackPoster();

	// postroll의 경우는 video content restore 함수를 호출하지 않는다.
	// 해당 함수 호출시 동영상의 첫부분이 다시 재생되는 문제가 있음.
	playerUtils.once(this.player, ['vast.adsCancel', 'vast.adEnd'], function() {
		self.removeAdUnit();
		self.restoreVideoContentAsContentEnded();
	});

	// 본 광고 시작
	this.tryToPlayAd();
};
