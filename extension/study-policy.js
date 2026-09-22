/* Researcher-controlled build configuration. No participant choices or upload credentials. */
(function(root,factory){const value=factory();if(typeof module==='object'&&module.exports)module.exports=value;else root.ReplikaStudyPolicy=value;})(globalThis,function(){
  'use strict';
  return Object.freeze({
    policy_version: 1,
    core_data: true,
    media_metadata: true,
    voice_audio: true,
    diary_images: true,
    sources: Object.freeze(['chat','diary','memories','profile'])
  });
});
