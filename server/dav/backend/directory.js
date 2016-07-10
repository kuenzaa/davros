var Fs = require('fs');
var Async = require("asyncjs");
var Path = require("path");

var jsDAV_FSExt_Directory = require("jsDAV/lib/DAV/backends/fsext/directory");
var jsDAV_iFile           = require("jsDAV/lib/DAV/interfaces/iFile");
var File                  = require("./file");
var Util = require("jsDAV/lib/shared/util");
var Exc = require("jsDAV/lib/shared/exceptions");
var Etag = require("./etag");
var CachedProperties      = require("./cached-properties");
var ChildProcess          = require("child_process");

var Directory = module.exports = jsDAV_FSExt_Directory.extend(jsDAV_iFile, Etag, {

  chunkMatch: /(.*?)-chunking-(\d+)-(\d+)-(\d+)(-done)?$/,

  isChunked: function(name) {
    return name.match(this.chunkMatch);
  },

  /**
   * Returns a specific child node, referenced by its name
   *
   * @param {String} name
   * @throws Sabre_DAV_Exception_FileNotFound
   * @return Sabre_DAV_INode
   */
  getChild: function(name, cbfsgetchild) {
    var path = Path.join(this.path, name);

    Fs.stat(path, function(err, stat) {
      if (err || typeof stat == "undefined") {
        return cbfsgetchild(new Exc.FileNotFound("File with name "
               + path + " could not be located"));
      }
      cbfsgetchild(null, stat.isDirectory()
                   ? Directory.new(path)
                   : File.new(path));
    });
  },

  /**
   * Returns an array with all the child nodes
   *
   * @return jsDAV_iNode[]
   */
  getChildren: function(cbfsgetchildren) {
    var nodes = [];
    Async.readdir(this.path)
      .stat()
      .filter(function(file) {
        return file.name !== File.PROPS_DIR;
      })
      .each(function(file, cbnextdirch) {
        nodes.push(file.stat.isDirectory()
                   ? Directory.new(file.path)
                   : File.new(file.path)
                  );
        cbnextdirch();
      })
      .end(function() {
        cbfsgetchildren(null, nodes);
      });
  },

  /**
   * Creates a new file in the directory
   *
   * data is a Buffer resource
   *
   * @param {String} name Name of the file
   * @param {Buffer} data Initial payload
   * @param {String} [enc]
   * @param {Function} cbfscreatefile
   * @return void
   */
  createFile: function(name, data, enc, cbfscreatefile) {
    var self = this;
    jsDAV_FSExt_Directory.createFile.call(this, name, data, enc,
                                          function(err) {
                                         if (err)
                                           return cbfscreatefile(err);

                                            var file = File.new([self.path, name].join('/'));
                                            file.getETag(cbfscreatefile);
                                       });
  },

  /**
   * Creates a new file in the directory whilst writing to a stream instead of
   * from Buffer objects that reside in memory.
   *
   * @param {jsDAV_Handler} handler
   * @param {String} name Name of the file
   * @param {String} [enc]
   * @param {Function} cbfscreatefile
   * @return void
   */
  createFileStream: function(handler, name, enc, cbfscreatefile) {
    var self = this;
    if (this.isChunked(name)) {
      handler.httpRequest.headers["oc-file-name"] = name;
      this.writeFileChunk(handler, enc, cbfscreatefile);
    } else {
      var path = Path.join(this.path, name);
      jsDAV_FSExt_Directory.createFileStream.call(this, handler, name, enc, function() {
        var file = File.new([self.path, name].join('/'));
        file.getETag(cbfscreatefile);
      });
    }
  },

  writeFileChunk: function(handler, type, cbfswritechunk) {
    var self = this;

    var filename = handler.httpRequest.headers["oc-file-name"];
    var chunkSize = parseInt(handler.httpRequest.headers['oc-chunk-size']);
    var size = parseInt(handler.httpRequest.headers["oc-total-length"]);

    var parts = this.isChunked(filename);
    if(!parts) { return cbfswritechunk("Invalid chunked file upload"); }

    var originalName = parts[1];
    var uid = parts[2];
    var totalChunks = parseInt(parts[3]);
    var myChunk = parseInt(parts[4]);

    var startPosition = myChunk * chunkSize;

    var track = handler.server.chunkedUploads[uid];
    if (!track) {
      track = handler.server.chunkedUploads[uid] = {
        path: Path.join(handler.server.tmpDir, uid),
        filename: filename,
        timeout: null,
        count: 0
      };
    }
    clearTimeout(track.timeout);
    // if it takes more than ten minutes for the next chunk to
    // arrive, remove the temp file and consider this a failed upload.
    track.timeout = setTimeout(function() {
      delete handler.server.chunkedUploads[uid];
      Fs.unlink(track.path, function() {});
    }, 600000); //10 minutes timeout

    var stream = Fs.createWriteStream(track.path, {
      encoding: type,
      flags: track.count === 0 ? "w+" : "r+",
      start: startPosition
    });

    stream.on("close", function() {
      track.count += 1;
      if (track.count === totalChunks) {
        delete handler.server.chunkedUploads[uid];
        var originalPath = Path.join(self.path, originalName);
        Util.move(track.path, originalPath, true, function(err) {
          if (err)
            return;
          handler.dispatchEvent("afterBind", handler.httpRequest.url,
                                Path.join(self.path, filename));

          self.getETag(cbfswritechunk);
        });
      } else {
        cbfswritechunk(null, null);
      }
    });

    handler.getRequestBody(type, stream, false, function() {});
  },

  // We redefine fsext's `delete` because it uses asyncjs rmtree, which causes
  // stack overflows on very large directories.
  "delete": function(cbfsdel) {
    ChildProcess.spawn("rm", ["-rf", this.path]).on("exit", function(err) {
      if(err) {
        cbfsdel(err)
      } else {
        cbfsdel(null);
      }
    });
  }
});
