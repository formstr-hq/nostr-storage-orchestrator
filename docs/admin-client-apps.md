# Admin and Client Control Plane

The admin-backend needs to be renamed to control plane backend. The control plane has 2 roles - admin and client with the responsibilities defined below. There are 2 levels of architecture. In any setup there will be 1 host and n clients. The request will come to the host and the host will send the request to multiple or single clients depending upon the tier of the request

### Who are admins?

Admin are the gods of this app. They can remove any client. They can authorise any client to add storages. They are the ones who can manage the host. They can also remove any client and its storage from the roster. However, they cannot reassign any storage to any other client. They also have client privileges as well, i.e. they can give their own storage to the host. They are also able to view overview of the roster like how many clients present, how much storage present, how much storage left, how many client and storages active, etc

## Who are clients?

Clients are basically npubs who provide storage to the roster. Once a client is authorised by an admin, the client should be able to spin up a storage, generate an invite, and add its storage to the roster. Client should be able to signal how much storage is available to share and this should be configurable even after the storage is added to the roster.

## Functionalities required

Functionalities need to built for the above capabilities to be possible.

1. The blossom and relay clients need to be dynamic instead of being read from .env. When a client adds a storage to the roster, the storage will ping the host its ip and port, and the host will add its entry to the db. The host also needs to maintain the client and storage mapping which will be used to maintain ownerships
2. The available storage also needs to come from the client and saved in the db rather than be dynamic. However, the control plane will need to verify if the claimed amount of storage is present in the storage.
3. The authorized clients need to come from db. The authorized clients can only be edited by admins
4. The admins will also come from db.
5. Whenever a new storage is added, the blossom and relay cache should be refreshed
6. Currently, the connection from servers to the app is with http and legacy IPs. I want the connection to be made using FIPs. The control plane server will be running a fips node and be reachable via fips. Check out here for a POC https://github.com/abh3po/fips-capacitor. All apis within the control plane server will be nip 98 authed.
7. The control plane server for the storage will need the client npub as .env input for authorization.
8. A user can be a part of multiple hosts. Inside the host, their will be multiple storages. A user maybe an admin for the host or simply a client. If a user is atleast a client only then the user should be able to view details of the host. The details and capabilities of a user will be shown on the basis of the role of the user.
9. There should be an easy way/script to view the fips address/nvpn ip from the running server.

## Architecture guidelines

1. Considering the above, there will be DB migrations required. Extend the dbaas service for this
2. The control plane server is to be written in rust. Follow the rust good practices
3. The app needs to be in vite plus react with android and desktop native builds through tauri. The business logic should be written in rust and be as common as possible.
4. There needs to e2e tests and unit tests for the control plane backend and e2e test for app with backend mocked out.
5. Make small human maintainable files not more than 300 lines. The functionalities should be focused and composable.
